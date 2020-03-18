import { SocketSession } from './comms'
import { MainUI } from './ui/component/ui'
import { scala, vega } from './ui/monaco/languages'
import { theme } from './ui/monaco/theme'
import * as monaco from "monaco-editor";
import * as Tinycon from "tinycon";
import {MarkdownIt} from "./util/markdown-it";

window.MarkdownIt = MarkdownIt;

// set up custom highlighters
monaco.languages.register({ id: 'scala' });
monaco.languages.setMonarchTokensProvider('scala', scala.definition);
monaco.languages.setLanguageConfiguration('scala', scala.config);

monaco.languages.register({id: 'vega'});
monaco.languages.setMonarchTokensProvider('vega', vega.definition);
monaco.languages.setLanguageConfiguration('vega', vega.config);

// use our theme
monaco.editor.defineTheme('polynote', theme);

// open the global socket for control messages
SocketSession.global;

const mainUI = new MainUI();
const mainEl = document.getElementById('Main');
mainEl?.appendChild(mainUI.el);
const path = unescape(window.location.pathname.replace(new URL(document.baseURI).pathname, ''));
const notebookBase = 'notebook/';
if (path.startsWith(notebookBase)) {
  mainUI.loadNotebook(path.substring(notebookBase.length));
} else {
  mainUI.showWelcome();
}

Tinycon.setOptions({
    background: '#308b24'
});
