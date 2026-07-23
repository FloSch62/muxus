import { useEffect, useRef } from 'react';
import Editor, { loader, type OnMount } from '@monaco-editor/react';
import * as monaco from 'monaco-editor/editor/editor.api';
import 'monaco-editor/language/css/monaco.contribution';
import 'monaco-editor/language/html/monaco.contribution';
import 'monaco-editor/language/json/monaco.contribution';
import 'monaco-editor/language/typescript/monaco.contribution';
import 'monaco-editor/languages/definitions/cpp/register';
import 'monaco-editor/languages/definitions/dockerfile/register';
import 'monaco-editor/languages/definitions/go/register';
import 'monaco-editor/languages/definitions/ini/register';
import 'monaco-editor/languages/definitions/java/register';
import 'monaco-editor/languages/definitions/lua/register';
import 'monaco-editor/languages/definitions/markdown/register';
import 'monaco-editor/languages/definitions/php/register';
import 'monaco-editor/languages/definitions/python/register';
import 'monaco-editor/languages/definitions/ruby/register';
import 'monaco-editor/languages/definitions/rust/register';
import 'monaco-editor/languages/definitions/shell/register';
import 'monaco-editor/languages/definitions/sql/register';
import 'monaco-editor/languages/definitions/xml/register';
import 'monaco-editor/languages/definitions/yaml/register';
/* oxlint-disable import/default -- Vite's ?worker transform supplies these constructor defaults. */
import editorWorker from 'monaco-editor/editor/editor.worker?worker';
import cssWorker from 'monaco-editor/language/css/css.worker?worker';
import htmlWorker from 'monaco-editor/language/html/html.worker?worker';
import jsonWorker from 'monaco-editor/language/json/json.worker?worker';
import tsWorker from 'monaco-editor/language/typescript/ts.worker?worker';
/* oxlint-enable import/default */

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

const EDITOR_OPTIONS: monaco.editor.IStandaloneEditorConstructionOptions = {
  automaticLayout: true,
  bracketPairColorization: { enabled: true },
  cursorBlinking: 'smooth',
  cursorSmoothCaretAnimation: 'on',
  fontFamily: '"JetBrains Mono", "SFMono-Regular", Consolas, monospace',
  fontLigatures: true,
  fontSize: 13,
  minimap: { enabled: true, maxColumn: 90, renderCharacters: false, showSlider: 'mouseover' },
  padding: { top: 12, bottom: 12 },
  renderWhitespace: 'selection',
  scrollBeyondLastLine: false,
  smoothScrolling: true,
  stickyScroll: { enabled: true },
  tabSize: 2,
  wordWrap: 'off',
};

export default function MonacoTextEditor({
  path,
  language,
  value,
  dark,
  readOnly,
  onChange,
  onSave,
}: {
  path: string;
  language: string;
  value: string;
  dark: boolean;
  readOnly: boolean;
  onChange: (value: string) => void;
  onSave: () => void;
}) {
  const saveRef = useRef(onSave);
  useEffect(() => {
    saveRef.current = onSave;
  }, [onSave]);

  const onMount: OnMount = (editor) => {
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => saveRef.current());
    editor.focus();
  };

  return (
    <Editor
      height="100%"
      path={`sftp://${path}`}
      language={language}
      value={value}
      theme={dark ? 'vs-dark' : 'light'}
      keepCurrentModel
      saveViewState
      options={{ ...EDITOR_OPTIONS, readOnly }}
      onChange={(next) => onChange(next ?? '')}
      onMount={onMount}
      loading=""
    />
  );
}
