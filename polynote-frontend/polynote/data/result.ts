'use strict';

import {
    Codec, DataReader, DataWriter, discriminated, combined, arrayCodec, optional,
    str, shortStr, tinyStr, uint8, uint16, int32, ior, CodecContainer
} from './codec'

import {ValueRepr, StringRepr, MIMERepr, StreamingDataRepr, DataRepr, LazyDataRepr, DataStream} from './value_repr'
import {int16, int64} from "./codec";
import {Cell, CodeCell} from "../ui/component/cell";
import {displayData, displaySchema} from "../ui/component/display_content";
import {div, h4, iconButton, span} from "../ui/util/tags";
import * as monaco from "monaco-editor";
import {ValueInspector} from "../ui/component/value_inspector";
import {StructType} from "./data_type";
import {SocketSession} from "../comms";

export class Result extends CodecContainer {
    static codec: Codec<Result>;
    static codecs: typeof Result[];
    static msgTypeId: number;

    static decode(data: ArrayBuffer | DataView) {
        return Codec.decode(Result.codec, data);
    }

    static encode(msg: Result) {
        return Codec.encode(Result.codec, msg);
    }
}

export class Output extends Result {
    static codec = combined(str, str).to(Output);
    static get msgTypeId() { return 0; }

    static unapply(inst: Output): ConstructorParameters<typeof Output> {
        return [inst.contentType, inst.content];
    }

    constructor(readonly contentType: string, readonly content: string) {
        super(contentType, content);
        Object.freeze(this);
    }
}

export class Position {
    static codec = combined(str, int32, int32, int32).to(Position);
    static unapply(inst: Position): ConstructorParameters<typeof Position> {
        return [inst.source, inst.start, inst.end, inst.point];
    }

    constructor(readonly source: string, readonly start: number, readonly end: number, readonly point: number) {
        Object.freeze(this);}
}

export class KernelReport {
    static codec = combined(Position.codec, str, int32).to(KernelReport);
    static unapply(inst: KernelReport): ConstructorParameters<typeof KernelReport> {
        return [inst.position, inst.message, inst.severity];
    }

    constructor(readonly position: Position, readonly message: string, readonly severity: number) {
        Object.freeze(this);
    }

    get isError() {
        return this.severity === 2;
    }
}

export class CompileErrors extends Result {
    static codec = combined(arrayCodec(int32, KernelReport.codec)).to(CompileErrors);
    static get msgTypeId() { return 1; }

    static unapply(inst: CompileErrors): ConstructorParameters<typeof CompileErrors> {
        return [inst.reports];
    }

    constructor(readonly reports: KernelReport[]) {
        super();
        Object.freeze(this);
    }
}


// maps to JVM stack trace element
export class StackTraceElement {
    static codec = combined(str, str, str, int32).to(StackTraceElement);
    static unapply(inst: StackTraceElement): ConstructorParameters<typeof StackTraceElement> {
        return [inst.className, inst.method, inst.file, inst.line];
    }

    constructor(readonly className: string, readonly method: string, readonly file: string, readonly line: number) {
        Object.freeze(this);
    }
}

// maps to JVM Throwable
// WARNING: not frozen (mutable)
export class ServerError {
    static codec = combined(str, str, arrayCodec(uint16, StackTraceElement.codec)).to(ServerError);
    static unapply(inst: ServerError): ConstructorParameters<typeof ServerError> {
        return [inst.className, inst.message, inst.stackTrace];
    }

    public id: string;
    public extraContent: string;

    constructor(public className: string, public message: string, public stackTrace: StackTraceElement[]) {
        this.className = className;
        this.message = message;
        this.stackTrace = stackTrace;
        if (this.className.includes("UnrecoverableError")) {
            this.id = "Unrecoverable Error";
            this.extraContent = "Polynote encountered an unrecoverable error. Please reload your browser window to continue :-(";
        } else {
            this.id = "Kernel Error";
            this.extraContent = "Please see the console for more details";
        }
    }
}

export class ServerErrorWithCause {
    static codec = Codec.map<ServerError[], ServerErrorWithCause | null>(
        arrayCodec(uint8, ServerError.codec),
        (kernelErrors: ServerError[]) => {
            if (kernelErrors.length === 0) return null;

            let i = kernelErrors.length - 1;
            let current = new ServerErrorWithCause(kernelErrors[i].className, kernelErrors[i].message, kernelErrors[i].stackTrace);

            while (i > 0) {
                const next = kernelErrors[--i];
                current = new ServerErrorWithCause(next.className, next.message, next.stackTrace, current);
            }
            return current;
        },
        (withCause: ServerErrorWithCause | null) => {
            if (withCause == null) return [];
            const errs = [];
            let current: ServerErrorWithCause | undefined = withCause;
            let i = 0;
            while (i < 16 && current != null) {
                errs.push(new ServerError(current.className, current.message, current.stackTrace));
                current = current.cause;
                i++;
            }

            return errs;
        }
    );
    static unapply(inst: ServerErrorWithCause): ConstructorParameters<typeof ServerErrorWithCause> {
        return [inst.className, inst.message, inst.stackTrace, inst.cause];
    }

    constructor(readonly className: string, readonly message: string, readonly stackTrace: StackTraceElement[], readonly cause?: ServerErrorWithCause) {
        Object.freeze(this);
    }
}


export class RuntimeError extends Result {
    static codec = combined(ServerErrorWithCause.codec).to(RuntimeError);
    static get msgTypeId() { return 2; }

    static unapply(inst: RuntimeError): ConstructorParameters<typeof RuntimeError> {
        return [inst.error];
    }

    constructor(readonly error: ServerErrorWithCause) {
        super();
        Object.freeze(this);
    }

    static fromJS = (err: Error) => new RuntimeError(new ServerErrorWithCause(err.constructor.name, err.message || err.toString(), []));
}

export class ClearResults extends Result {
    static codec = Object.freeze({
        encode: (value: ClearResults, writer: DataWriter) => undefined,
        decode: (reader: DataReader) => ClearResults.instance
    });
    static get msgTypeId() { return 3; }

    static unapply(inst: ClearResults): ConstructorParameters<typeof ClearResults> {
        return [];
    }

    constructor() {
        super();
        Object.freeze(this);
    }

    static instance = new ClearResults();
}


export class PosRange {
    static codec = combined(int32, int32).to(PosRange);
    static unapply(inst: PosRange): ConstructorParameters<typeof PosRange> {
        return [inst.start, inst.end];
    }

    constructor(readonly start: number, readonly end: number) {
        Object.freeze(this);
    }

    get reversed() {
        return new PosRange(this.end, this.start);
    }

    get asString() {
        return `${this.start}-${this.end}`
    }

    equals(other: PosRange): Boolean {
        return this.start === other.start && this.end === other.end
    }

    static fromString(serialized: string): PosRange {
        const [start, end] = serialized.split("-");
        return new PosRange(parseInt(start), parseInt(end));
    }
}


export class ResultValue extends Result {
    static codec = combined(tinyStr, tinyStr, arrayCodec(uint8, ValueRepr.codec), int16, optional(PosRange.codec)).to(ResultValue);
    static get msgTypeId() { return 4; }

    static unapply(inst: ResultValue) {
        return [inst.name, inst.typeName, inst.reprs, inst.sourceCell, inst.pos];
    }

    constructor(readonly name: string, readonly typeName: string, readonly reprs: ValueRepr[], readonly sourceCell: number, readonly pos?: PosRange) {
        super();
        Object.freeze(this);
    }

    get valueText() {
        const index = this.reprs.findIndex(repr => repr instanceof StringRepr);
        if (index < 0) return "";
        return (this.reprs[index] as StringRepr).string;
    }

    /**
     * Get a default MIME type and string, for display purposes
     */
    displayRepr(cell: CodeCell, valueInspector: ValueInspector): Promise<[string, string | DocumentFragment]> {
        // We're searching for the best MIME type and representation for this result by going in order of most to least
        // useful (kind of arbitrarily defined...)
        // TODO: make this smarter
        // TODO: for lazy data repr, inform that it can't be displayed immediately

        let index = -1;

        // First, check to see if there's a special DataRepr or StreamingDataRepr
        index = this.reprs.findIndex(repr => repr instanceof DataRepr);
        if (index >= 0) {
            return monaco.editor.colorize(this.typeName, "scala", {}).then(typeHTML => {
                const dataRepr = this.reprs[index] as DataRepr;
                const frag = document.createDocumentFragment();
                const resultType = span(['result-type'], []).attr("data-lang" as any, "scala");
                resultType.innerHTML = typeHTML;
                frag.appendChild(div([], [
                    h4(['result-name-and-type'], [span(['result-name'], [this.name]), ': ', resultType]),
                    displayData(dataRepr.dataType.decodeBuffer(new DataReader(dataRepr.data)), undefined, 1)
                ]));
                return ["text/html", frag];
            })
        }

        index = this.reprs.findIndex(repr => repr instanceof StreamingDataRepr);
        if (index >= 0) {
            const repr = this.reprs[index] as StreamingDataRepr;
            // surprisingly using monaco.editor.colorizeElement breaks the theme of the whole app! WAT?
            return monaco.editor.colorize(this.typeName, cell.language, {}).then(typeHTML => {
                const streamingRepr = this.reprs[index] as StreamingDataRepr;
                const frag = document.createDocumentFragment();
                const resultType = span(['result-type'], []).attr("data-lang" as any, "scala");
                resultType.innerHTML = typeHTML;
                // Why do they put a <br> in there?
                [...resultType.getElementsByTagName("br")].forEach(br => {
                    br?.parentNode?.removeChild(br)
                });

                const el = div([], [
                    h4(['result-name-and-type'], [
                        span(['result-name'], [this.name]), ': ', resultType,
                        iconButton(['view-data'], 'View data', 'table', '[View]')
                            .click(_ => valueInspector.inspect(this, cell.notebook, 'View data')),
                        repr.dataType instanceof StructType
                            ? iconButton(['plot-data'], 'Plot data', 'chart-bar', '[Plot]')
                                .click(_ => {
                                    valueInspector.setParent(cell);
                                    valueInspector.inspect(this, cell.notebook, 'Plot data');
                                })
                            : undefined
                    ]),
                    repr.dataType instanceof StructType ? displaySchema(streamingRepr.dataType) : undefined
                ]);
                frag.appendChild(el);
                return ["text/html", frag];
            })
        }

        // next, if it's a MIMERepr we want to follow this order
        const mimeOrder = [
            "image/",
            "application/x-latex",
            "text/html",
            "text/",
        ];

        for (const partialMime of mimeOrder) {
            index = this.reprs.findIndex(repr => repr instanceof MIMERepr && repr.mimeType.startsWith(partialMime));
            if (index >= 0) return Promise.resolve(MIMERepr.unapply(this.reprs[index] as MIMERepr));
        }

        // ok, maybe there's some other mime type we didn't expect?
        index = this.reprs.findIndex(repr => repr instanceof MIMERepr);
        if (index >= 0) return Promise.resolve(MIMERepr.unapply(this.reprs[index] as MIMERepr));

        // just give up and show some plaintext...
        return Promise.resolve(["text/plain", this.valueText]);
    }
}



/**
 * A result originating on the client, from a client-side interpreter. It has to tell us how to display itself and
 * how it should be saved in the notebook.
 */
export class ClientResult extends Result {
    constructor() {
        super();
    }

    display(targetEl: HTMLElement, cell: Cell) {
        throw new Error(`Class ${this.constructor.name} does not implement display()`);
    }

    toOutput(): Promise<Output> {
        throw new Error(`Class ${this.constructor.name} does not implement toOutput()`);
    }
}

export class ExecutionInfo extends Result {
    static codec = combined(int64, optional(int64)).to(ExecutionInfo);
    static get msgTypeId() { return 5; }

    static unapply(inst: ExecutionInfo): ConstructorParameters<typeof ExecutionInfo> {
        return [inst.startTs, inst.endTs];
    }

    constructor(readonly startTs: number, readonly endTs?: number) {
        super(startTs, endTs);

        this.startTs = startTs;
        this.endTs = endTs;

        Object.freeze(this);
    }
}

Result.codecs = [
  Output,           // 0
  CompileErrors,    // 1
  RuntimeError,     // 2
  ClearResults,     // 3
  ResultValue,      // 4
  ExecutionInfo,    // 5
];

Result.codec = discriminated(
    uint8,
    (msgTypeId) => Result.codecs[msgTypeId].codec,
    (result) => (result.constructor as typeof Result).msgTypeId
);


