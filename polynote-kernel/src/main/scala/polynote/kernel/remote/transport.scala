package polynote.kernel
package remote

import java.io.{BufferedReader, IOException, InputStreamReader}
import java.net.InetSocketAddress
import java.nio.ByteBuffer
import java.nio.channels.{AsynchronousCloseException, ClosedChannelException, ServerSocketChannel, SocketChannel}
import java.nio.file.Paths
import java.util.concurrent.{Semaphore, TimeUnit}

import cats.effect.concurrent.Deferred
import fs2.Stream
import polynote.config.PolynoteConfig
import polynote.kernel.environment.{Config, CurrentNotebook, CurrentTask}
import polynote.kernel.logging.Logging
import polynote.kernel.remote.SocketTransport.FramedSocket
import polynote.messages._
import scodec.{Codec, Decoder}
import scodec.codecs.implicits._
import scodec.bits.BitVector
import scodec.stream.decode
import zio.Cause._
import zio.blocking.{Blocking, effectBlocking}
import zio.clock.Clock
import zio.internal.Executor
import zio.{Cause, Promise, RIO, Task, ZIO, ZSchedule}
import zio.duration.{durationInt, Duration => ZDuration}
import zio.interop.catz._

import scala.concurrent.TimeoutException
import scala.concurrent.duration.{Duration, MILLISECONDS, MINUTES, SECONDS}
import scala.reflect.{ClassTag, classTag}
import Update.notebookUpdateCodec
import cats.arrow.FunctionK
import cats.~>

trait Transport[ServerAddress] {
  def serve(): RIO[BaseEnv with GlobalEnv with CurrentNotebook with TaskManager, TransportServer[ServerAddress]]
  def connect(address: ServerAddress): TaskB[TransportClient]
}


trait TransportServer[ServerAddress] {
  /**
    * The responses coming from the client
    */
  def responses: Stream[TaskB, RemoteResponse]

  /**
    * Send a request to the client
    */
  def sendRequest(req: RemoteRequest): TaskB[Unit]

  def sendNotebookUpdate(update: NotebookUpdate): TaskB[Unit]

  /**
    * Shut down the server and any processes it's deployed
    */
  def close(): TaskB[Unit]

  def awaitClosed: Task[Unit]

  /**
    * @return whether the transport is connected (i.e. can a request be sent)
    */
  def isConnected: TaskB[Boolean]

  def address: TaskB[ServerAddress]
}

trait TransportClient {
  /**
    * Send a response to the server
    */
  def sendResponse(rep: RemoteResponse): TaskB[Unit]

  /**
    * The requests coming from the server
    */
  def requests: Stream[TaskB, RemoteRequest]

  def updates: Stream[TaskB, NotebookUpdate]

  /**
    * Shut down the client
    */
  def close(): TaskB[Unit]
}

// TODO: need some fault tolerance mechanism here, like reconnecting on socket errors
class SocketTransportServer private (
  server: ServerSocketChannel,
  channels: SocketTransport.Channels,
  private[polynote] val process: SocketTransport.DeployedProcess,
  closed: Promise[Throwable, Unit]
) extends TransportServer[InetSocketAddress] {

  override def sendRequest(req: RemoteRequest): TaskB[Unit] = for {
    msg     <- ZIO.fromEither(RemoteRequest.codec.encode(req).toEither).mapError(err => new RuntimeException(err.message))
    _       <- channels.mainChannel.write(msg).onError(cause => Logging.error(s"Remote kernel failed to send request (it will probably die now)", cause))
  } yield ()

  private val updateCodec = Codec[NotebookUpdate]

  override def sendNotebookUpdate(update: NotebookUpdate): TaskB[Unit] = for {
    msg <- ZIO.fromEither(updateCodec.encode(update).toEither).mapError(err => new RuntimeException(err.message))
    _   <- channels.notebookUpdatesChannel.write(msg)
  } yield ()

  override val responses: Stream[TaskB, RemoteResponse] =
        channels.mainChannel.bitVectors
          .interruptAndIgnoreWhen(closed)
          .through(scodec.stream.decode.pipe[TaskB, RemoteResponse])

  override def close(): TaskB[Unit] = closed.succeed(()) *> channels.close() *> process.awaitOrKill(30)

  override def isConnected: TaskB[Boolean] = ZIO(channels.isConnected)

  override def address: TaskB[InetSocketAddress] = effectBlocking(Option(server.getLocalAddress)).flatMap {
    case Some(addr: InetSocketAddress) => ZIO.succeed(addr)
    case _ => ZIO.fail(new RuntimeException("No valid address"))
  }

  override def awaitClosed: Task[Unit] = closed.await
}

object SocketTransportServer {
  private def selectChannels(channel1: FramedSocket, channel2: FramedSocket, address: InetSocketAddress): TaskB[SocketTransport.Channels] = {
    def identify(channel: FramedSocket) = channel.read().repeat {
      ZSchedule.doUntil[Option[Option[ByteBuffer]]] {
        case Some(Some(_)) => true
        case _ => false
      }
    }.flatMap {
      case Some(Some(buf)) => IdentifyChannel.decodeBuffer(buf)
      case _               => ZIO.fail(new IllegalStateException("No buffer was received"))
    }

    (identify(channel1) zipPar identify(channel2)).flatMap {
      case (MainChannel, NotebookUpdatesChannel) => ZIO.succeed(SocketTransport.Channels(channel1, channel2, address))
      case (NotebookUpdatesChannel, MainChannel) => ZIO.succeed(SocketTransport.Channels(channel2, channel1, address))
      case other => ZIO.fail(new IllegalStateException(s"Illegal channel set: $other"))
    }
  }

  def apply(
    server: ServerSocketChannel,
    channel1: FramedSocket,
    channel2: FramedSocket,
    process: SocketTransport.DeployedProcess
  ): TaskB[SocketTransportServer] = for {
    closed   <- Promise.make[Throwable, Unit]
    channels <- selectChannels(channel1, channel2, server.getLocalAddress.asInstanceOf[InetSocketAddress])
    _        <- channel1.awaitClosed.to(closed).fork
    _        <- channel2.awaitClosed.to(closed).fork
  } yield new SocketTransportServer(server, channels, process, closed)
}

class SocketTransportClient private (channels: SocketTransport.Channels, closed: Promise[Throwable, Unit]) extends TransportClient {

  def logError(fn: Cause[Throwable] => ZIO[Logging, Nothing, Unit]): TaskB ~> TaskB = new ~>[TaskB, TaskB] {
    override def apply[A](fa: TaskB[A]): TaskB[A] = fa.onError(fn)
  }

  private val requestStream = channels.mainChannel.bitVectors
    .translate(logError(Logging.error("Remote kernel client's request stream had an networking error (it will probably die now)", _)))
    .through(decode.pipe[TaskB, RemoteRequest])

  private val updateStream = channels.notebookUpdatesChannel.bitVectors
    .translate(logError(Logging.error("Remote kernel client's update stream had an networking error (it will probably die now)", _)))
    .through(decode.pipe[TaskB, NotebookUpdate])

  def sendResponse(rep: RemoteResponse): TaskB[Unit] = for {
    bytes <- ZIO.fromEither(RemoteResponse.codec.encode(rep).toEither).mapError(err => new RuntimeException(err.message))
    _     <- channels.mainChannel.write(bytes)
      .onError(Logging.error(s"Remote kernel client had an error sending a response (it will probably die now)", _))
  } yield ()

  override val requests: Stream[TaskB, RemoteRequest] = requestStream.terminateAfter(_.isInstanceOf[ShutdownRequest])

  override val updates: Stream[TaskB, NotebookUpdate] = updateStream.interruptAndIgnoreWhen(closed)

  def close(): TaskB[Unit] = closed.succeed(()) *> channels.close()
}

object SocketTransportClient {
  def apply(channels: SocketTransport.Channels): Task[SocketTransportClient] = for {
    closed <- Promise.make[Throwable, Unit]
  } yield new SocketTransportClient(channels, closed)
}

/**
  * A transport that communicates over a socket with a kernel process it's deployed via spark-submit.
  * Requires that spark-submit is a valid executable command on the path.
  */
class SocketTransport(
  deploy: SocketTransport.Deploy,
  forceServerAddress: Option[String] = None
) extends Transport[InetSocketAddress] {

  private def openServerChannel: RIO[Blocking, ServerSocketChannel] = effectBlocking {
    ServerSocketChannel.open().bind(
      new InetSocketAddress(
        forceServerAddress.getOrElse(java.net.InetAddress.getLocalHost.getHostAddress), 0))
  }

  private def startConnection(
    server: ServerSocketChannel,
    timeout: ZDuration = 3.minutes
  ): TaskB[FramedSocket] = {
    for {
      channel <- effectBlocking(server.accept())
      framed  <- FramedSocket(channel, keepalive = true)
    } yield framed
  }.timeout(timeout).flatMap {
    case Some(s) => ZIO.succeed(s)
    case None    => ZIO.fail(new TimeoutException(s"Remote kernel process failed to start after ${timeout.asScala}"))
  }

  private[polynote] def deployAndServe(): RIO[BaseEnv with GlobalEnv with CurrentNotebook with TaskManager, (TransportServer[InetSocketAddress], SocketTransport.DeployedProcess)] =
    TaskManager.run("RemoteKernel", "Remote kernel", "Starting remote kernel") {
      for {
        socketServer  <- openServerChannel
        serverAddress  = socketServer.getLocalAddress.asInstanceOf[InetSocketAddress]
        process       <- deploy.deployKernel(this, serverAddress)
        _             <- CurrentTask.update(_.progress(0.5, Some("Waiting for remote kernel")))
        connection    <- startConnection(socketServer)
        connection2   <- startConnection(socketServer)
        server        <- SocketTransportServer(socketServer, connection, connection2, process)
      } yield (server, process)
    }

  def serve(): RIO[BaseEnv with GlobalEnv with CurrentNotebook with TaskManager, TransportServer[InetSocketAddress]] =
    deployAndServe().map(_._1)

  def connect(serverAddress: InetSocketAddress): TaskB[TransportClient] = SocketTransport.connectClient(serverAddress)
}

object SocketTransport {

  case class Channels(
    mainChannel: FramedSocket,
    notebookUpdatesChannel: FramedSocket,
    address: InetSocketAddress
  ) {
    def isConnected: Boolean = mainChannel.isConnected && notebookUpdatesChannel.isConnected
    def close(): TaskB[Unit] = ZIO.sequencePar(Seq(mainChannel.close(), notebookUpdatesChannel.close())).unit
  }

  def connectClient(serverAddress: InetSocketAddress): TaskB[TransportClient] = for {
    mainChannel    <- effectBlocking(SocketChannel.open(serverAddress)) >>= (FramedSocket(_, keepalive = true))
    updatesChannel <- effectBlocking(SocketChannel.open(serverAddress)) >>= (FramedSocket(_, keepalive = true))
    _              <- IdentifyChannel.encode(MainChannel) >>= mainChannel.write
    _              <- IdentifyChannel.encode(NotebookUpdatesChannel) >>= updatesChannel.write
    channels        = SocketTransport.Channels(mainChannel, updatesChannel, serverAddress)
    client         <- SocketTransportClient(channels)
  } yield client

  /**
    * Deploys the remote kernel which will connect back to the server (for example by running spark-submit in a subprocess)
    */
  trait Deploy {
    def deployKernel(
      transport: SocketTransport,
      serverAddress: InetSocketAddress
    ): RIO[BaseEnv with GlobalEnv with CurrentNotebook, DeployedProcess]
  }

  /**
    * An interface to the process created by [[Deploy]]
    */
  trait DeployedProcess {
    def exitStatus: RIO[BaseEnv, Option[Int]]
    def awaitExit(timeout: Long, timeUnit: java.util.concurrent.TimeUnit): RIO[BaseEnv, Option[Int]]
    def kill(): RIO[BaseEnv, Unit]
    def awaitOrKill(gracePeriodSeconds: Long): RIO[BaseEnv, Unit] = awaitExit(gracePeriodSeconds, TimeUnit.SECONDS).flatMap {
      case Some(status) => ZIO.unit
      case None => kill() *> awaitExit(gracePeriodSeconds, TimeUnit.SECONDS).flatMap {
        case Some(status) => ZIO.unit
        case None => ZIO.fail(new Exception("Unable to kill deployed process"))
      }
    }
  }


  /**
    * Deployment implementation which shells out to spark-submit
    */
  class DeploySubprocess(deployCommand: DeploySubprocess.DeployCommand) extends Deploy {

    private def logProcess(process: Process) = {
      ZIO(new BufferedReader(new InputStreamReader(process.getInputStream))).flatMap {
        stream => effectBlocking(stream.readLine()).tap {
          case null => ZIO.unit
          case line => Logging.remote(line)
        }.repeat(ZSchedule.doUntil(line => line == null)).unit
      }
    }

    override def deployKernel(
      transport: SocketTransport,
      serverAddress: InetSocketAddress
    ): RIO[BaseEnv with GlobalEnv with CurrentNotebook, DeployedProcess] = deployCommand(serverAddress).flatMap {
      command =>
        val displayCommand = command.map {
          str => if (str contains " ") s""""$str"""" else str
        }.mkString(" ")

        val processBuilder = new ProcessBuilder(command: _*).redirectErrorStream(true)
        for {
          _        <- Logging.info(s"Deploying with command:\n$displayCommand")
          config   <- Config.access
          nbConfig <- CurrentNotebook.config
          _        <- ZIO {
            val processEnv = processBuilder.environment()
            (config.env ++ nbConfig.env.getOrElse(Map.empty)).foreach {
              case (k,v) => processEnv.put(k, v)
            }
          }
          process  <- effectBlocking(processBuilder.start())
          _        <- logProcess(process).fork
        } yield new DeploySubprocess.Subprocess(process)
    }
  }

  object DeploySubprocess {
    trait DeployCommand {
      def apply(serverAddress: InetSocketAddress): RIO[Config with CurrentNotebook, Seq[String]]
    }

    /**
      * Deploy by starting a Java process that inherits classpath and environment variables from this process
      */
    class DeployJava[KernelFactory <: Kernel.Factory.Service : ClassTag] extends DeployCommand {
      override def apply(serverAddress: InetSocketAddress): RIO[Config with CurrentNotebook, Seq[String]] = ZIO {
        val java = Paths.get(System.getProperty("java.home"), "bin", "java").toString
        val javaArgs = sys.process.javaVmArguments.filterNot(_ startsWith "-agentlib")
        val classPath = System.getProperty("java.class.path")
        java :: "-cp" :: classPath :: javaArgs :::
          classOf[RemoteKernelClient].getName ::
          "--address" :: serverAddress.getAddress.getHostAddress ::
          "--port" :: serverAddress.getPort.toString ::
          "--kernelFactory" :: classTag[KernelFactory].runtimeClass.getName ::
          Nil
      }
    }

    class Subprocess(process: Process) extends DeployedProcess {
      override def exitStatus: RIO[Blocking, Option[Int]] = for {
        alive <- effectBlocking(process.isAlive)
      } yield if (alive) None else Option(process.exitValue())

      override def kill(): RIO[Blocking, Unit] = effectBlocking {
        process.destroy()
      }

      override def awaitExit(timeout: Long, timeUnit: java.util.concurrent.TimeUnit): RIO[Blocking, Option[Int]] = effectBlocking {
        if (process.waitFor(timeout, timeUnit)) {
          Some(process.exitValue())
        } else {
          None
        }
      }
    }
  }

  /**
    * Produces a stream of [[BitVector]]s from a [[SocketChannel]]. We should be able to use [[scodec.stream.decode.StreamDecoder.decodeChannel]]
    * instead, but it doesn't seem to emit anything. So this auxiliary class is used instead.
    *
    * It reads a framed message into a single [[ByteBuffer]]. The message must be framed by preceeding it with a
    * signed 32-bit big-endian length, not including the 4 bytes of the length itself.
    *
    * It also includes a method to write such a framed message to the channel from a [[BitVector]].
    */
  // TODO: Maybe fs2.io.tcp.Socket methods could be made to work, just seems over-complicated for single-client server?
  // TODO: If this introduces allocation/GC latency, could try to use a shared, reused buffer
  class FramedSocket(socketChannel: SocketChannel, closed: Promise[Throwable, Unit]) {
    private val incomingLengthBuffer = ByteBuffer.allocate(4)
    private val outgoingLengthBuffer = ByteBuffer.allocate(4)

    // using primitive j.u.concurrent Semaphore here, because I need tryAcquire (zio Semaphore doesn't have it)
    // TODO: When zio Sempaphore has tryAcquire, use that instead
    private val writeLock = new Semaphore(1)

    private def readBuffer(): Option[Option[ByteBuffer]] = incomingLengthBuffer.synchronized {
      incomingLengthBuffer.rewind()
      while(incomingLengthBuffer.hasRemaining) {
        if(socketChannel.read(incomingLengthBuffer) == -1) {
          return None
        }
      }

      val len = incomingLengthBuffer.getInt(0)
      if (len < 0) {
        None
      } else if (len == 0) {
        Some(None)
      } else {
        val msgBuffer = ByteBuffer.allocate(len)
        while (msgBuffer.hasRemaining) {
          socketChannel.read(msgBuffer)
        }

        msgBuffer.rewind()
        Some(Some(msgBuffer))
      }
    }

    def read(): TaskB[Option[Option[ByteBuffer]]] = effectBlocking(readBuffer()).uninterruptible.catchSome {
      case err: AsynchronousCloseException => Logging.info("Remote peer closed connection") *> close() *> ZIO.succeed(None)
    }.tapError {
      err => closed.fail(err)
    }

    def write(msg: BitVector): TaskB[Unit] = ZIO.effectTotal(writeLock.acquire()).bracket(_ => ZIO.effectTotal(writeLock.release())) {
      _ => effectBlocking {
        val byteVector = msg.toByteVector
        val size = byteVector.size.toInt
        writeSize(size)
        val byteBuffer = byteVector.toByteBuffer
        while (byteBuffer.hasRemaining) {
          socketChannel.write(byteBuffer)
        }
      }.uninterruptible
    }.tapError {
      case err: ClosedChannelException => close()
      case err => closed.fail(err) *> close()
    }

    // MUST SYNCHRONIZE on writeLock to invoke this!
    private def writeSize(size: Int) = {
      outgoingLengthBuffer.rewind()
      outgoingLengthBuffer.putInt(0, size)
      socketChannel.write(outgoingLengthBuffer)
    }

    // send a keepalive, but if the channel is already being written, do nothing (don't queue a keepalive)
    def sendKeepalive(): TaskB[Unit] = ZIO.effectTotal(writeLock.tryAcquire(0, TimeUnit.SECONDS)).bracket(
      acquired => if (acquired) ZIO.effectTotal(writeLock.release()) else ZIO.unit).apply {
      acquired => if (acquired) effectBlocking(writeSize(0)) else ZIO.unit
    }

    def close(): TaskB[Unit] =  ZIO.effectTotal(writeLock.acquire()).bracket(_ => ZIO.effectTotal(writeLock.release())) {
      _ => effectBlocking(socketChannel.close()).uninterruptible <* closed.succeed(())
    }

    def isConnected: Boolean = socketChannel.isConnected

    def awaitClosed: Task[Unit] = closed.await

    val bitVectors: Stream[TaskB, BitVector] =
      Stream.repeatEval(read())
        .handleErrorWith(err => Stream.eval(Logging.error("Remote kernel connection failure", err) *> closed.fail(err)).drain)
        .unNoneTerminate.unNone
        .map(BitVector.view)
  }

  object FramedSocket {
    def apply(socketChannel: SocketChannel, keepalive: Boolean = true): TaskB[FramedSocket] = {
      for {
        closed       <- Promise.make[Throwable, Unit]
        framedSocket  = new FramedSocket(socketChannel, closed)
        doKeepalive  <- if (keepalive) {
          // This sends a keepalive quite frequently, because it's the only way we can detect if the remote peer dies.
          // It only sends 16 bytes per second, though, and they only send if the channel isn't being written.
          framedSocket.sendKeepalive().tapError {
            err =>
              closed.fail(err) *> effectBlocking(socketChannel.close())
          }.repeat(ZSchedule.spaced(ZDuration(250, TimeUnit.MILLISECONDS))).fork
        } else ZIO.unit
      } yield framedSocket
    }
  }
}