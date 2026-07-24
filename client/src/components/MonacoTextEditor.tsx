import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Editor, { loader, type OnMount } from '@monaco-editor/react';
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
import { GENERAL_TEXT_LANGUAGE_ID } from '../editor/language-detection.js';
import './MonacoTextEditor.css';

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

const EDITOR_OPTIONS: monaco.editor.IStandaloneEditorConstructionOptions = {
  accessibilitySupport: 'auto',
  acceptSuggestionOnEnter: 'smart',
  autoClosingBrackets: 'languageDefined',
  autoClosingComments: 'languageDefined',
  autoClosingQuotes: 'languageDefined',
  autoIndent: 'full',
  autoIndentOnPaste: true,
  autoSurround: 'languageDefined',
  automaticLayout: true,
  bracketPairColorization: { enabled: true, independentColorPoolPerBracketType: true },
  codeLens: true,
  colorDecorators: true,
  contextmenu: true,
  cursorBlinking: 'smooth',
  cursorSmoothCaretAnimation: 'on',
  dragAndDrop: true,
  find: { addExtraSpaceOnTop: false, seedSearchStringFromSelection: 'selection' },
  folding: true,
  foldingHighlight: true,
  foldingImportsByDefault: true,
  fontFamily: '"JetBrains Mono", "SFMono-Regular", Consolas, monospace',
  fontLigatures: true,
  fontSize: 13,
  formatOnPaste: true,
  formatOnType: true,
  glyphMargin: true,
  guides: {
    bracketPairs: true,
    bracketPairsHorizontal: 'active',
    highlightActiveBracketPair: true,
    highlightActiveIndentation: true,
    indentation: true,
  },
  hover: { above: false, delay: 250, sticky: true },
  inlayHints: { enabled: 'onUnlessPressed' },
  lightbulb: { enabled: monaco.editor.ShowLightbulbIconMode.On },
  linkedEditing: true,
  links: true,
  matchBrackets: 'always',
  minimap: {
    autohide: 'mouseover',
    enabled: true,
    maxColumn: 90,
    renderCharacters: false,
    showSlider: 'mouseover',
    size: 'fit',
  },
  mouseWheelZoom: true,
  multiCursorModifier: 'alt',
  occurrencesHighlight: 'singleFile',
  padding: { top: 12, bottom: 12 },
  parameterHints: { cycle: true, enabled: true },
  quickSuggestions: { comments: 'off', other: 'on', strings: 'on' },
  renderLineHighlight: 'all',
  renderValidationDecorations: 'on',
  renderWhitespace: 'selection',
  scrollBeyondLastLine: false,
  selectionHighlight: true,
  showFoldingControls: 'mouseover',
  smoothScrolling: true,
  snippetSuggestions: 'inline',
  stickyScroll: { enabled: true, maxLineCount: 5, scrollWithEditor: true },
  stickyTabStops: true,
  suggest: {
    localityBonus: true,
    preview: true,
    previewMode: 'subwordSmart',
    shareSuggestSelections: true,
    showStatusBar: true,
  },
  suggestOnTriggerCharacters: true,
  tabCompletion: 'on',
  tabSize: 2,
  unusualLineTerminators: 'prompt',
  wordBasedSuggestions: 'matchingDocuments',
  wordWrap: 'off',
  wrappingIndent: 'indent',
};

interface EditorStatus {
  column: number;
  eol: 'LF' | 'CRLF';
  errors: number;
  insertSpaces: boolean;
  language: string;
  line: number;
  selectionCount: number;
  selectedCharacters: number;
  tabSize: number;
  warnings: number;
  wordWrap: boolean;
}

const INITIAL_STATUS: EditorStatus = {
  column: 1,
  eol: 'LF',
  errors: 0,
  insertSpaces: true,
  language: GENERAL_TEXT_LANGUAGE_ID,
  line: 1,
  selectionCount: 1,
  selectedCharacters: 0,
  tabSize: 2,
  warnings: 0,
  wordWrap: false,
};

const languageOptions = [
  { id: 'plaintext', label: 'Plain Text' },
  ...monaco.languages
    .getLanguages()
    .filter((language) => language.id !== 'plaintext' && !language.id.includes('.tag-'))
    .map((language) => ({
      id: language.id,
      label: language.aliases?.[0] ?? language.id,
    }))
    .sort((left, right) => left.label.localeCompare(right.label)),
];
const workspaceDisposalTimers = new Map<string, number>();

function modelUri(workspaceId: string, path: string): string {
  const encodedPath = path.split('/').map(encodeURIComponent).join('/');
  return `sftp://${encodeURIComponent(workspaceId)}${encodedPath.startsWith('/') ? encodedPath : `/${encodedPath}`}`;
}

function statusEquals(left: EditorStatus, right: EditorStatus): boolean {
  return (
    left.column === right.column &&
    left.eol === right.eol &&
    left.errors === right.errors &&
    left.insertSpaces === right.insertSpaces &&
    left.language === right.language &&
    left.line === right.line &&
    left.selectionCount === right.selectionCount &&
    left.selectedCharacters === right.selectedCharacters &&
    left.tabSize === right.tabSize &&
    left.warnings === right.warnings &&
    left.wordWrap === right.wordWrap
  );
}

export default function MonacoTextEditor({
  workspaceId,
  openPaths,
  path,
  language,
  value,
  dark,
  readOnly,
  onChange,
  onLanguageChange,
  onSave,
  onSaveAll,
  onClose,
  onNextTab,
  onPreviousTab,
}: {
  workspaceId: string;
  openPaths: string[];
  path: string;
  language: string;
  value: string;
  dark: boolean;
  readOnly: boolean;
  onChange: (value: string) => void;
  onLanguageChange: (language: string) => void;
  onSave: () => void;
  onSaveAll: () => void;
  onClose: () => void;
  onNextTab: () => void;
  onPreviousTab: () => void;
}) {
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const mountedDisposablesRef = useRef<monaco.IDisposable[]>([]);
  const callbacksRef = useRef({
    onChange,
    onClose,
    onLanguageChange,
    onNextTab,
    onPreviousTab,
    onSave,
    onSaveAll,
  });
  const [status, setStatus] = useState<EditorStatus>(INITIAL_STATUS);

  useEffect(() => {
    callbacksRef.current = {
      onChange,
      onClose,
      onLanguageChange,
      onNextTab,
      onPreviousTab,
      onSave,
      onSaveAll,
    };
  }, [
    onChange,
    onClose,
    onLanguageChange,
    onNextTab,
    onPreviousTab,
    onSave,
    onSaveAll,
  ]);

  useEffect(
    () => () => {
      for (const disposable of mountedDisposablesRef.current) disposable.dispose();
      mountedDisposablesRef.current = [];
      editorRef.current = null;
    },
    [],
  );

  const handleMount = useCallback<OnMount>((editor) => {
    editorRef.current = editor;
    const disposables: monaco.IDisposable[] = [];
    let modelDisposables: monaco.IDisposable[] = [];

    const updateStatus = () => {
      const model = editor.getModel();
      const position = editor.getPosition();
      const selections = editor.getSelections() ?? [];
      if (!model || !position) return;

      let selectedCharacters = 0;
      for (const selection of selections) {
        if (!selection.isEmpty()) selectedCharacters += model.getValueLengthInRange(selection);
      }
      const markers = monaco.editor.getModelMarkers({ resource: model.uri });
      const modelOptions = model.getOptions();
      const next: EditorStatus = {
        column: position.column,
        eol: model.getEOL() === '\r\n' ? 'CRLF' : 'LF',
        errors: markers.filter((marker) => marker.severity === monaco.MarkerSeverity.Error).length,
        insertSpaces: modelOptions.insertSpaces,
        language: model.getLanguageId(),
        line: position.lineNumber,
        selectionCount: selections.length || 1,
        selectedCharacters,
        tabSize: modelOptions.tabSize,
        warnings: markers.filter((marker) => marker.severity === monaco.MarkerSeverity.Warning).length,
        wordWrap: editor.getOption(monaco.editor.EditorOption.wordWrap) !== 'off',
      };
      setStatus((current) => (statusEquals(current, next) ? current : next));
    };

    const bindModel = () => {
      for (const disposable of modelDisposables) disposable.dispose();
      const model = editor.getModel();
      modelDisposables = model
        ? [
            model.onDidChangeContent(updateStatus),
            model.onDidChangeLanguage(updateStatus),
            model.onDidChangeOptions(updateStatus),
          ]
        : [];
      updateStatus();
    };

    disposables.push(
      editor.onDidChangeCursorSelection(updateStatus),
      editor.onDidChangeConfiguration(updateStatus),
      editor.onDidChangeModel(bindModel),
      monaco.editor.onDidChangeMarkers((resources) => {
        const resource = editor.getModel()?.uri;
        if (resource && resources.some((candidate) => candidate.toString() === resource.toString())) {
          updateStatus();
        }
      }),
      {
        dispose: () => {
          for (const disposable of modelDisposables) disposable.dispose();
          modelDisposables = [];
        },
      },
    );

    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => callbacksRef.current.onSave());
    editor.addCommand(
      monaco.KeyMod.chord(
        monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyK,
        monaco.KeyCode.KeyS,
      ),
      () => callbacksRef.current.onSaveAll(),
    );
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyW, () => callbacksRef.current.onClose());
    editor.addCommand(
      monaco.KeyMod.CtrlCmd | monaco.KeyCode.PageDown,
      () => callbacksRef.current.onNextTab(),
    );
    editor.addCommand(
      monaco.KeyMod.CtrlCmd | monaco.KeyCode.PageUp,
      () => callbacksRef.current.onPreviousTab(),
    );

    bindModel();
    mountedDisposablesRef.current = disposables;
    editor.focus();
  }, []);

  const handleChange = useCallback((next: string | undefined) => {
    callbacksRef.current.onChange(next ?? '');
  }, []);

  const options = useMemo(
    () => ({
      ...EDITOR_OPTIONS,
      ariaLabel: `Editor for ${path}`,
      domReadOnly: readOnly,
      readOnly,
      readOnlyMessage: { value: 'Reconnect the SSH session to edit this file.' },
    }),
    [path, readOnly],
  );
  const resource = useMemo(() => modelUri(workspaceId, path), [path, workspaceId]);
  const openResources = useMemo(
    () => openPaths.map((openPath) => modelUri(workspaceId, openPath)),
    [openPaths, workspaceId],
  );
  const previousResourcesRef = useRef(openResources);

  useEffect(() => {
    const open = new Set(openResources);
    for (const previousResource of previousResourcesRef.current) {
      if (open.has(previousResource)) continue;
      const model = monaco.editor.getModel(monaco.Uri.parse(previousResource));
      if (model && model !== editorRef.current?.getModel()) model.dispose();
    }
    previousResourcesRef.current = openResources;
  }, [openResources]);

  useEffect(() => {
    const pending = workspaceDisposalTimers.get(workspaceId);
    if (pending !== undefined) {
      window.clearTimeout(pending);
      workspaceDisposalTimers.delete(workspaceId);
    }
    return () => {
      const timer = window.setTimeout(() => {
        for (const openResource of previousResourcesRef.current) {
          monaco.editor.getModel(monaco.Uri.parse(openResource))?.dispose();
        }
        workspaceDisposalTimers.delete(workspaceId);
      }, 0);
      workspaceDisposalTimers.set(workspaceId, timer);
    };
  }, [workspaceId]);

  const changeLanguage = useCallback((nextLanguage: string) => {
    const model = editorRef.current?.getModel();
    if (!model) return;
    monaco.editor.setModelLanguage(model, nextLanguage);
    callbacksRef.current.onLanguageChange(nextLanguage);
  }, []);

  const changeIndentation = useCallback((next: string) => {
    const model = editorRef.current?.getModel();
    if (!model) return;
    if (next === 'tabs') model.updateOptions({ insertSpaces: false });
    else model.updateOptions({ insertSpaces: true, tabSize: Number(next) });
  }, []);

  const changeEol = useCallback((next: 'LF' | 'CRLF') => {
    editorRef.current
      ?.getModel()
      ?.setEOL(
        next === 'CRLF'
          ? monaco.editor.EndOfLineSequence.CRLF
          : monaco.editor.EndOfLineSequence.LF,
      );
  }, []);

  const runAction = useCallback((actionId: string) => {
    void editorRef.current?.getAction(actionId)?.run();
  }, []);

  const toggleWordWrap = useCallback(() => {
    const editor = editorRef.current;
    if (!editor) return;
    const wrapped = editor.getOption(monaco.editor.EditorOption.wordWrap) !== 'off';
    editor.updateOptions({ wordWrap: wrapped ? 'off' : 'on' });
  }, []);

  const markerCount = status.errors + status.warnings;
  return (
    <div className="muxus-monaco" data-theme={dark ? 'dark' : 'light'}>
      <div className="muxus-monaco__editor">
        <Editor
          height="100%"
          path={resource}
          language={language}
          value={value}
          theme={dark ? 'vs-dark' : 'light'}
          keepCurrentModel
          saveViewState
          options={options}
          onChange={handleChange}
          onMount={handleMount}
          loading=""
        />
      </div>
      <footer className="muxus-monaco__status" aria-label="Editor status">
        <button
          type="button"
          className="muxus-monaco__status-button"
          title="Go to line (Ctrl/Cmd+G)"
          onClick={() => runAction('editor.action.gotoLine')}
        >
          Ln {status.line}, Col {status.column}
        </button>
        {status.selectedCharacters > 0 ? (
          <span className="muxus-monaco__status-item">
            {status.selectedCharacters} selected
            {status.selectionCount > 1 ? ` in ${status.selectionCount} cursors` : ''}
          </span>
        ) : status.selectionCount > 1 ? (
          <span className="muxus-monaco__status-item">{status.selectionCount} cursors</span>
        ) : null}
        {markerCount > 0 ? (
          <button
            type="button"
            className="muxus-monaco__status-button"
            title="Go to next problem (F8)"
            onClick={() => runAction('editor.action.marker.next')}
          >
            <span aria-label={`${status.errors} errors`}>ⓧ {status.errors}</span>
            <span aria-label={`${status.warnings} warnings`}>△ {status.warnings}</span>
          </button>
        ) : null}
        <span className="muxus-monaco__status-spacer" />
        <button
          type="button"
          className={`muxus-monaco__status-button${status.wordWrap ? ' is-active' : ''}`}
          title="Toggle word wrap (Alt+Z)"
          onClick={toggleWordWrap}
        >
          Wrap
        </button>
        <button
          type="button"
          className="muxus-monaco__status-button"
          disabled={readOnly}
          title="Format document (Shift+Alt+F)"
          onClick={() => runAction('editor.action.formatDocument')}
        >
          {'{ }'}
        </button>
        <select
          className="muxus-monaco__status-select"
          aria-label="Indentation"
          title="Select indentation"
          value={status.insertSpaces ? String(status.tabSize) : 'tabs'}
          onChange={(event) => changeIndentation(event.target.value)}
        >
          <option value="tabs">Tabs</option>
          <option value="2">Spaces: 2</option>
          <option value="4">Spaces: 4</option>
          <option value="8">Spaces: 8</option>
        </select>
        <select
          className="muxus-monaco__status-select"
          aria-label="End of line sequence"
          title="Select end of line sequence"
          value={status.eol}
          disabled={readOnly}
          onChange={(event) => changeEol(event.target.value as 'LF' | 'CRLF')}
        >
          <option value="LF">LF</option>
          <option value="CRLF">CRLF</option>
        </select>
        <span className="muxus-monaco__status-item" title="File encoding">
          UTF-8
        </span>
        <select
          className="muxus-monaco__status-select muxus-monaco__status-language"
          aria-label="Language mode"
          title="Select language mode"
          value={status.language}
          onChange={(event) => changeLanguage(event.target.value)}
        >
          {languageOptions.map((option) => (
            <option key={option.id} value={option.id}>
              {option.label}
            </option>
          ))}
        </select>
      </footer>
    </div>
  );
}
