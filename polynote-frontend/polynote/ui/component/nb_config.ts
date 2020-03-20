"use strict"

import {UIMessage, UIMessageTarget} from "../util/ui_event";
import {
    button,
    div,
    dropdown,
    DropdownElement,
    h2,
    h3,
    iconButton,
    para,
    span,
    TagElement,
    textbox
} from "../util/tags";
import {IvyRepository, MavenRepository, NotebookConfig, PipRepository, RepositoryConfig} from "../../data/data";

export class NotebookConfigUI extends UIMessageTarget {
    readonly el: TagElement<"div">;
    private lastConfig: NotebookConfig;
    private configHandler: NotebookConfigHandler;
    private saveButton: TagElement<"button", HTMLButtonElement>;

    constructor(private onConfigUpdate: (conf: NotebookConfig) => void) {
        super();

        this.el = div(['notebook-config'], []);
        this.setConfig(NotebookConfig.default)
    }

    setConfig(config: NotebookConfig) {
        this.lastConfig = config;
        this.configHandler = new NotebookConfigHandler(config);

        const children = [
            h2(['config'], ['Configuration & dependencies']).click(() => this.el.classList.toggle('open')),
            div(['content'], [
                div(['notebook-dependencies', 'notebook-config-section'], [
                    h3([], ['Dependencies']),
                    para([], ['You can provide Scala / JVM dependencies using  Maven coordinates , e.g. ', span(['pre'], ['org.myorg:package-name_2.11:1.0.1']), ', or URLs like ', span(['pre'], ['s3://path/to/my.jar'])]),
                    para([], ['You can also specify pip packages, e.g. ', span(['pre'], ['requests']), ', or with a version like ', span(['pre'], ['urllib3==1.25.3'])]),
                    this.configHandler.dependencyContainer
                ]),
                div(['notebook-resolvers', 'notebook-config-section'], [
                    h3([], ['Resolvers']),
                    para([], ['Specify any custom Ivy, Maven, or Pip repositories here.']),
                    this.configHandler.resolverContainer
                ]),
                div(['notebook-exclusions', 'notebook-config-section'], [
                    h3([], ['Exclusions']),
                    para([], ['[Scala only]: Specify organization:module coordinates for your exclusions, i.e. ', span(['pre'], ['org.myorg:package-name_2.11'])]),
                    this.configHandler.exclusionContainer
                ]),
                div(['notebook-spark-config', 'notebook-config-section'], [
                    h3([], ['Spark Config']),
                    para([], ['Set Spark configuration for this notebook here. Please note that it is possible that your environment may override some of these settings at runtime :(']),
                    this.configHandler.sparkConfigContainer
                ]),
                div(['notebook-env', 'notebook-config-section'], [
                    h3([], ['Environment Variables']),
                    para([], ['Set environment variables here. Please note this is only supported when kernels are launched as a subprocess (default).']),
                    this.configHandler.envContainer
                ]),
                div(['controls'], [
                    this.saveButton = button(['save'], {}, ['Save & Restart']).click(evt => {
                        const conf = this.configHandler.toConfig();
                        this.lastConfig = conf;
                        this.el.classList.remove("open");
                        this.onConfigUpdate(conf);
                    }),
                    button(['cancel'], {}, ['Cancel']).click(evt => {
                        if (this.lastConfig) {
                            this.setConfig(this.lastConfig);
                        }
                        this.el.classList.remove("open");
                    })
                ])
            ])
        ];

        while (this.el.childNodes.length > 0) {
            this.el.removeChild(this.el.childNodes[0]);
        }

        children.forEach(el => this.el.appendChild(el));
    }

    setKernelState(state: 'busy' | 'idle' | 'dead' | 'disconnected') {
        if (state === 'disconnected') {
            this.saveButton.disabled = true;
        } else {
            this.saveButton.disabled = false;
            if (state === 'dead') {
                this.saveButton.textContent = "Save"
            } else {
                this.saveButton.textContent = "Save & Restart"
            }
        }
    }
}

/**
 * Handle changes to the notebook config, propagating them to the config UI.
 */
interface Dep {
    data: {
        lang: string,
        dep: string
    }
}

interface Excl {
    data: {
        exclusion: string
    }
}

interface Res {
    data: {
        type: string,
        url: string,
        pattern?: string,
        metadata?: string
    }
}

interface SparkConf {
    data: {
        key: string,
        val: string
    }
}

interface Env {
    data: {
        key: string,
        val: string
    }
}

class NotebookConfigHandler extends UIMessageTarget {
    readonly dependencyContainer: TagElement<"div">;
    readonly resolverContainer: TagElement<"div">;
    readonly exclusionContainer: TagElement<"div">;
    readonly sparkConfigContainer: TagElement<"div">;
    readonly envContainer: TagElement<"div">;

    private dependencies: Dep[] = [];
    private exclusions: Excl[] = [];
    private resolvers: Res[] = [];
    private sparkConfigs: SparkConf[] = [];
    private env: Env[] = [];

    constructor(private config: NotebookConfig) {
        super();

        this.dependencyContainer = div(['dependency-list'], []);
        this.resolverContainer = div(['resolver-list'], []);
        this.exclusionContainer = div(['exclusion-list'], []);
        this.sparkConfigContainer = div(['spark-config-list'], []);
        this.envContainer = div(['env-list'], []);

        if (config.dependencies) {
            for (const [lang, deps] of Object.entries(config.dependencies)) {
                for (const dep of deps) {
                    this.addDep({data: {lang, dep}});
                }
            }
        }
        if (this.dependencies.length == 0) this.addDep();

        if (config.exclusions) {
            for (const excl of config.exclusions) {
                this.addExcl({data: {exclusion: excl}});
            }
        }
        if (this.exclusions.length == 0) this.addExcl();

        if (config.repositories) {
            for (const repository of config.repositories) {
                if (repository instanceof IvyRepository) {
                    this.addRes({data: {type: "ivy", url: repository.url, pattern: repository.artifactPattern, metadata: repository.metadataPattern}});
                } else if (repository instanceof MavenRepository) {
                    this.addRes({data: {type: "maven", url: repository.url}});
                } else if (repository instanceof PipRepository) {
                    this.addRes({data: {type: "pip", url: repository.url}});
                } else {
                    throw new Error(`Unknown repository type! Don't know what to do with ${JSON.stringify(repository)}`)
                }
            }
        }
        if (this.resolvers.length == 0) this.addRes();

        if (config.sparkConfig) {
            for (const [key, val] of Object.entries(config.sparkConfig)) {
                this.addSparkConf({data: {key, val}});
            }
        }
        if (this.sparkConfigs.length == 0) this.addSparkConf();

        if (config.env) {
            for (const [key, val] of Object.entries(config.env)) {
                this.addEnv({data: {key, val}});
            }
        }
        if (this.env.length == 0) this.addEnv();

    }

    toConfig(): NotebookConfig {
        const deps = this.dependencies.reduce<Record<string, string[]>>((acc, next) => {
            if (next.data.dep) acc[next.data.lang] = [...(acc[next.data.lang] || []), next.data.dep];
            return acc;
        }, {});

        const exclusions = this.exclusions.flatMap(excl => excl.data.exclusion ? [excl.data.exclusion] : []);

        const resolvers = this.resolvers.flatMap(res => {
            if (res.data.url) {
                let repo;
                switch (res.data.type) {
                    case "ivy":
                        repo = new IvyRepository(res.data.url, res.data.pattern, res.data.metadata);
                        break;
                    case "maven":
                        repo = new MavenRepository(res.data.url);
                        break;
                    case "pip":
                        repo =  new PipRepository(res.data.url);
                        break;
                    default:
                        throw new Error(`Unknown repository type! Don't know what to do with ${res.data.type}`)
                }
                return [repo]
            } else { return [] }
        });

        const sparkConf = this.sparkConfigs.reduce<Record<string, string>>((acc, next) => {
            if (next.data.val) acc[next.data.key] = next.data.val;
            return acc;
        }, {});

        const env = this.env.reduce<Record<string, string>>((acc, next) => {
            if (next.data.val) acc[next.data.key] = next.data.val;
            return acc;
        }, {});

        return new NotebookConfig(
            deps,
            exclusions,
            resolvers,
            sparkConf,
            env
        )

    }

    addDep(value?: Dep) {
        const defaultLang = "scala"; // TODO: make this configurable
        const dep = {
            elements: {
                type: dropdown(['dependency-type'], {scala: 'scala/jvm', python: 'pip'}, value?.data.lang ?? defaultLang).change(evt => {
                    const self = dep.elements.type;
                    dep.row.classList.remove(dep.data.lang);
                    dep.data.lang = self.options[self.selectedIndex].value;
                    dep.row.classList.add(dep.data.lang);

                }) as DropdownElement,
                dep: textbox(['dependency'], 'Dependency coordinate, URL, pip package', value?.data.dep).change(evt => {
                    dep.data.dep = dep.elements.dep.value
                }),
                remove: iconButton(['remove'], 'Remove', 'minus-circle-red', 'Remove').click(evt => {
                    this.dependencyContainer.removeChild(dep.row);
                    this.dependencies = this.dependencies.filter(d => d !== dep);
                    if (this.dependencies.length === 0) this.addDep()
                }),
                add: iconButton(['add'], 'Add', 'plus-circle', 'Add').click(evt => {
                    this.addDep(dep)
                }),
            },
            row: div(['dependency-row', 'notebook-config-row'], []),
            data: {
                lang: value?.data.lang ?? defaultLang,
                dep: value?.data.dep ?? ""
            }
        };

        for (const el of Object.values(dep.elements)) {
            dep.row.appendChild(el);
        }

        this.dependencyContainer.appendChild(dep.row);
        this.dependencies.push(dep);

        return dep;
    }

    addRes(value?: Res) {
        const defaultRes = "ivy"; // TODO: make this configurable
        const res = {
            elements: {
                type: dropdown(['resolver-type'], {ivy: 'Ivy', maven: 'Maven', pip: 'Pip'}, value?.data.type ?? defaultRes).change(evt => {
                    const self = res.elements.type;
                    res.row.classList.remove(res.data.type);
                    res.data.type = self.options[self.selectedIndex].value;
                    res.row.classList.add(res.data.type);
                }) as DropdownElement,

                url: textbox(['resolver-url'], 'Resolver URL or pattern', value?.data.url).change(() => {
                    res.data.url = res.elements.url.value;
                }),
                pattern: textbox(['resolver-artifact-pattern', 'ivy'], 'Artifact pattern (blank for default)', value?.data.pattern).change(() => {
                    res.data.pattern = res.elements.pattern.value
                }),
                metadata: textbox(['resolver-metadata-pattern', 'ivy'], 'Metadata pattern (blank for default)', value?.data.metadata).change(() => {
                    res.data.metadata = res.elements.metadata.value
                }),
                remove: iconButton(['remove'], 'Remove', 'minus-circle-red', 'Remove').click(evt => {
                    this.resolverContainer.removeChild(res.row);
                    this.resolvers = this.resolvers.filter(r => r !== res);
                    if (this.resolvers.length === 0) this.addRes()
                }),
                add: iconButton(['add'], 'Add', 'plus-circle', 'Add').click(evt => {
                    this.addRes(res)
                }),
            },
            row: div(['resolver-row', 'notebook-config-row', value?.data.type ?? defaultRes], []),
            data: {
                type: value?.data.type ?? defaultRes,
                url: value?.data.url ?? "",
                pattern: value?.data.pattern,
                metadata: value?.data.pattern
            }
        };

        for (const el of Object.values(res.elements)) {
            res.row.appendChild(el);
        }

        this.resolverContainer.appendChild(res.row);
        this.resolvers.push(res);

        return res;
    }

    addExcl(value?: Excl) {
        const excl = {
            elements: {
                excl: textbox(['exclusion'], 'Exclusion organization:name', value?.data.exclusion).change(() => {
                    excl.data.exclusion = excl.elements.excl.value
                }),
                remove: iconButton(['remove'], 'Remove', 'minus-circle-red', 'Remove').click(evt => {
                    this.exclusionContainer.removeChild(excl.row);
                    this.exclusions = this.exclusions.filter(e => e !== excl);
                    if (this.exclusions.length === 0) this.addExcl()
                }),
                add: iconButton(['add'], 'Add', 'plus-circle', 'Add').click(evt => {
                    this.addExcl()
                }),
            },
            row: div(['exclusion-row', 'notebook-config-row'], []),
            data: {
                exclusion: value?.data.exclusion ?? "",
            }
        };

        for (const el of Object.values(excl.elements)) {
            excl.row.appendChild(el);
        }

        this.exclusionContainer.appendChild(excl.row);
        this.exclusions.push(excl);

        return excl;
    }

    addSparkConf(value?: SparkConf) {
        const conf = {
            elements: {
                key: textbox(['spark-config-key'], 'key', value?.data.key).change(() => {
                    conf.data.key = conf.elements.key.value
                }),
                val: textbox(['spark-config-val'], 'val', value?.data.val).change(() => {
                    conf.data.val = conf.elements.val.value
                }),
                remove: iconButton(['remove'], 'Remove', 'minus-circle-red', 'Remove').click(evt => {
                    this.sparkConfigContainer.removeChild(conf.row);
                    this.sparkConfigs = this.sparkConfigs.filter(c => c !== conf);
                    if (this.sparkConfigs.length === 0) this.addSparkConf()
                }),
                add: iconButton(['add'], 'Add', 'plus-circle', 'Add').click(evt => {
                    this.addSparkConf()
                }),
            },
            row: div(['exclusion-row', 'notebook-config-row'], []),
            data: {
                key: value?.data.key ?? "",
                val: value?.data.val ?? "",
            }
        };

        for (const el of Object.values(conf.elements)) {
            conf.row.appendChild(el);
        }

        this.sparkConfigContainer.appendChild(conf.row);
        this.sparkConfigs.push(conf);

        return conf;
    }

    addEnv(value?: Env) {
        const conf = {
            elements: {
                key: textbox(['env-key'], 'key', value?.data.key).change(() => {
                    conf.data.key = conf.elements.key.value
                }),
                val: textbox(['env-val'], 'val', value?.data.val).change(() => {
                    conf.data.val = conf.elements.val.value
                }),
                remove: iconButton(['remove'], 'Remove', 'minus-circle-red', 'Remove').click(evt => {
                    this.envContainer.removeChild(conf.row);
                    this.env = this.env.filter(c => c !== conf);
                    if (this.env.length === 0) this.addEnv()
                }),
                add: iconButton(['add'], 'Add', 'plus-circle', 'Add').click(evt => {
                    this.addEnv()
                }),
            },
            row: div(['exclusion-row', 'notebook-config-row'], []),
            data: {
                key: value?.data.key ?? "",
                val: value?.data.val ?? "",
            }
        };

        for (const el of Object.values(conf.elements)) {
            conf.row.appendChild(el);
        }

        this.envContainer.appendChild(conf.row);
        this.env.push(conf);

        return conf;
    }
}