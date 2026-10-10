/**
 * Monaco's one-time setup: workers, the bundled languages, the general text
 * language and script defaults. Every editor in the app imports Monaco from
 * here so the setup runs exactly once, in whichever lazy chunk loads first.
 */
import { loader } from '@monaco-editor/react';
import * as monaco from 'monaco-editor/editor/editor.api';
import 'monaco-editor/editor/editor.main';
import 'monaco-editor/languages/definitions/register.all';
import 'monaco-editor/language/css/monaco.contribution';
import 'monaco-editor/language/html/monaco.contribution';
import 'monaco-editor/language/json/monaco.contribution';
import {
  javascriptDefaults,
  JsxEmit,
  ModuleKind,
  ModuleResolutionKind,
  ScriptTarget,
  typescriptDefaults,
} from 'monaco-editor/languages/features/typescript/register';
/* oxlint-disable import/default -- Vite's ?worker transform supplies these constructor defaults. */
import editorWorker from 'monaco-editor/editor/editor.worker?worker';
import cssWorker from 'monaco-editor/language/css/css.worker?worker';
import htmlWorker from 'monaco-editor/language/html/html.worker?worker';
import jsonWorker from 'monaco-editor/language/json/json.worker?worker';
import tsWorker from 'monaco-editor/language/typescript/ts.worker?worker';
/* oxlint-enable import/default */
import { GENERAL_TEXT_LANGUAGE_ID } from './language-detection.js';

self.MonacoEnvironment = {
  getWorker(_moduleId, label) {
    if (label === 'json') return new jsonWorker();
    if (label === 'css' || label === 'scss' || label === 'less') return new cssWorker();
    if (label === 'html' || label === 'handlebars' || label === 'razor') return new htmlWorker();
    if (label === 'typescript' || label === 'javascript') return new tsWorker();
    return new editorWorker();
  },
};
loader.config({ monaco });

if (!monaco.languages.getLanguages().some((language) => language.id === GENERAL_TEXT_LANGUAGE_ID)) {
  monaco.languages.register({
    id: GENERAL_TEXT_LANGUAGE_ID,
    aliases: ['General Text', 'Text'],
    extensions: ['.txt', '.text', '.log', '.out'],
    mimetypes: ['text/plain'],
  });
}
monaco.languages.setMonarchTokensProvider(GENERAL_TEXT_LANGUAGE_ID, {
  brackets: [
    { open: '{', close: '}', token: 'delimiter.curly' },
    { open: '[', close: ']', token: 'delimiter.square' },
    { open: '(', close: ')', token: 'delimiter.parenthesis' },
  ],
  defaultToken: '',
  ignoreCase: true,
  tokenizer: {
    root: [
      [/^(?:<{7}|={7}|>{7}).*$/, 'invalid'],
      [/^\s*#{1,6}\s+.*$/, 'keyword'],
      [/^\s*(?:#|;|\/\/).*$/, 'comment'],
      [/\b(?:ERROR|FATAL|CRITICAL|PANIC|FAIL(?:ED|URE)?)\b/, 'invalid'],
      [/\b(?:WARN|WARNING|CAUTION)\b/, 'regexp'],
      [/\b(?:INFO|NOTICE|SUCCESS|OK)\b/, 'type'],
      [/\b(?:TRACE|DEBUG|VERBOSE)\b/, 'comment'],
      [/\b(?:TODO|FIXME|HACK|NOTE|IMPORTANT|XXX)\b/, 'keyword'],
      [/^(\s*(?:-\s+)?)([A-Za-z_][\w.-]*)(\s*)([:=])/, ['', 'attribute.name', '', 'delimiter']],
      [/\b(?:true|false|yes|no|on|off|enabled|disabled)\b/, 'keyword'],
      [/\b(?:null|nil|none|undefined|n\/a)\b/, 'constant'],
      [/\b\d{4}-\d{2}-\d{2}[T ][0-9:.+-]*Z?\b/, 'number'],
      [/\b\d{1,2}:\d{2}(?::\d{2}(?:\.\d+)?)?\b/, 'number'],
      [/\b(?:\d{1,3}\.){3}\d{1,3}(?::\d{1,5})?\b/, 'number'],
      [/\b[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}\b/, 'number.hex'],
      [/\b0x[0-9a-f]+\b/, 'number.hex'],
      [/\b\d+(?:\.\d+)?(?:ms|s|min|h|d|b|kb|mb|gb|tb|kib|mib|gib|tib|hz|khz|mhz|ghz|%)\b/, 'number'],
      [/\b\d+(?:\.\d+)?\b/, 'number'],
      [/\b(?:https?|wss?|ftp):\/\/[^\s<>{}[\]"']+/, 'string.link'],
      [/\b[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}\b/, 'string.link'],
      [/\$\{?[A-Za-z_][\w.-]*\}?/, 'variable'],
      [/(?:^|\s)--?[A-Za-z][\w-]*/, 'variable'],
      [/[A-Za-z]:\\(?:[^\\/:*?"<>|\r\n]+\\)*[^\\/:*?"<>|\r\n]*/, 'string.path'],
      [/(?:~|\.{1,2})?\/(?:[\w.@+-]+\/)*[\w.@+-]+/, 'string.path'],
      [/"(?:\\.|[^"\\])*"/, 'string'],
      [/'(?:\\.|[^'\\])*'/, 'string'],
      [/[{}()[\]]/, '@brackets'],
      [/[=:,|]/, 'delimiter'],
    ],
  },
});
monaco.languages.setLanguageConfiguration(GENERAL_TEXT_LANGUAGE_ID, {
  autoClosingPairs: [
    { open: '{', close: '}' },
    { open: '[', close: ']' },
    { open: '(', close: ')' },
    { open: '"', close: '"' },
    { open: "'", close: "'" },
  ],
  brackets: [
    ['{', '}'],
    ['[', ']'],
    ['(', ')'],
  ],
  surroundingPairs: [
    { open: '{', close: '}' },
    { open: '[', close: ']' },
    { open: '(', close: ')' },
    { open: '"', close: '"' },
    { open: "'", close: "'" },
  ],
});

const scriptCompilerOptions = {
  allowJs: true,
  allowNonTsExtensions: true,
  checkJs: false,
  esModuleInterop: true,
  jsx: JsxEmit.ReactJSX,
  module: ModuleKind.ESNext,
  moduleResolution: ModuleResolutionKind.NodeJs,
  resolveJsonModule: true,
  target: ScriptTarget.ESNext,
};
typescriptDefaults.setCompilerOptions(scriptCompilerOptions);
javascriptDefaults.setCompilerOptions(scriptCompilerOptions);
typescriptDefaults.setEagerModelSync(true);
javascriptDefaults.setEagerModelSync(true);

export { monaco };
