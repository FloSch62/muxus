import { useCallback, useEffect, useRef, useState } from 'react';
import Editor, { DiffEditor, type OnMount } from '@monaco-editor/react';
import Box from '@mui/material/Box';
import { useTheme } from '@mui/material/styles';
import { monaco } from '../../editor/monaco-setup.js';

/**
 * Monaco for request bodies and results: JSON values, XML filters and
 * configs, YANG modules. Small editors grow with their content up to a
 * limit; Ctrl/Cmd+Enter runs the request from inside the editor too.
 */

export type CodeLanguage = 'json' | 'xml' | 'yang' | 'plaintext' | 'shell' | 'python';

let yangRegistered = false;

/** A Monarch grammar for YANG (RFC 7950), enough to read device modules comfortably. */
function registerYang(): void {
  if (yangRegistered) return;
  yangRegistered = true;
  monaco.languages.register({ id: 'yang', extensions: ['.yang'], aliases: ['YANG'] });
  monaco.languages.setMonarchTokensProvider('yang', {
    keywords: [
      'action', 'anydata', 'anyxml', 'argument', 'augment', 'base', 'belongs-to', 'bit', 'case', 'choice',
      'config', 'contact', 'container', 'default', 'description', 'deviate', 'deviation', 'enum',
      'error-app-tag', 'error-message', 'extension', 'feature', 'fraction-digits', 'grouping', 'identity',
      'if-feature', 'import', 'include', 'input', 'key', 'leaf', 'leaf-list', 'length', 'list', 'mandatory',
      'max-elements', 'min-elements', 'modifier', 'module', 'must', 'namespace', 'notification', 'ordered-by',
      'organization', 'output', 'path', 'pattern', 'position', 'prefix', 'presence', 'range', 'reference',
      'refine', 'require-instance', 'revision', 'revision-date', 'rpc', 'status', 'submodule', 'type',
      'typedef', 'unique', 'units', 'uses', 'value', 'when', 'yang-version', 'yin-element',
    ],
    builtins: [
      'binary', 'bits', 'boolean', 'decimal64', 'empty', 'enumeration', 'identityref', 'instance-identifier',
      'int8', 'int16', 'int32', 'int64', 'leafref', 'string', 'uint8', 'uint16', 'uint32', 'uint64', 'union',
      'true', 'false', 'current', 'deprecated', 'obsolete', 'user', 'system', 'unbounded', 'add', 'delete',
      'replace', 'not-supported',
    ],
    tokenizer: {
      root: [
        [/\/\/.*$/, 'comment'],
        [/\/\*/, 'comment', '@comment'],
        [/"/, 'string', '@dstring'],
        [/'[^']*'/, 'string'],
        [/[a-zA-Z_][\w.-]*:[a-zA-Z_][\w.-]*/, 'type.identifier'],
        [
          /[a-zA-Z_][\w.-]*/,
          { cases: { '@keywords': 'keyword', '@builtins': 'type', '@default': 'identifier' } },
        ],
        [/\d+(\.\d+)?/, 'number'],
        [/[{};]/, 'delimiter'],
      ],
      comment: [
        [/[^/*]+/, 'comment'],
        [/\*\//, 'comment', '@pop'],
        [/[/*]/, 'comment'],
      ],
      dstring: [
        [/[^\\"]+/, 'string'],
        [/\\./, 'string.escape'],
        [/"/, 'string', '@pop'],
      ],
    },
  });
  monaco.languages.setLanguageConfiguration('yang', {
    comments: { lineComment: '//', blockComment: ['/*', '*/'] },
    brackets: [['{', '}']],
    autoClosingPairs: [
      { open: '{', close: '}' },
      { open: '"', close: '"' },
    ],
    folding: { markers: { start: /\{\s*$/, end: /^\s*\}/ } },
  });
}

const BASE_OPTIONS: monaco.editor.IStandaloneEditorConstructionOptions = {
  automaticLayout: true,
  fontFamily: '"JetBrains Mono", "SFMono-Regular", Consolas, monospace',
  fontLigatures: false,
  fontSize: 12.5,
  lineHeight: 19,
  minimap: { enabled: false },
  scrollBeyondLastLine: false,
  renderLineHighlight: 'none',
  overviewRulerLanes: 0,
  hideCursorInOverviewRuler: true,
  fixedOverflowWidgets: true,
  folding: true,
  tabSize: 2,
  insertSpaces: true,
  scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10, alwaysConsumeMouseWheel: false },
  padding: { top: 6, bottom: 6 },
  wordWrap: 'on',
  wrappingIndent: 'indent',
  stickyScroll: { enabled: false },
  guides: { indentation: true },
  bracketPairColorization: { enabled: true },
  formatOnPaste: true,
};

export function useDarkMode(): boolean {
  return useTheme().palette.mode === 'dark';
}

export function CodeEditor({
  value,
  onChange,
  language,
  readOnly = false,
  autoHeight,
  height,
  onRun,
  lineNumbers = true,
  placeholder,
  ariaLabel,
  modelPath,
}: {
  value: string;
  onChange?: (value: string) => void;
  language: CodeLanguage;
  readOnly?: boolean;
  /** Grow with the content between these many lines; otherwise fill the parent. */
  autoHeight?: { min: number; max: number };
  height?: number | string;
  onRun?: () => void;
  lineNumbers?: boolean;
  placeholder?: string;
  ariaLabel: string;
  /** Stable model URI, so undo history survives re-renders. */
  modelPath?: string;
}) {
  const dark = useDarkMode();
  const runRef = useRef(onRun);
  runRef.current = onRun;
  const [contentHeight, setContentHeight] = useState<number | undefined>(undefined);
  const lineHeight = 19;
  if (language === 'yang') registerYang();

  const handleMount = useCallback<OnMount>(
    (editor) => {
      editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => runRef.current?.());
      if (autoHeight) {
        const update = () => setContentHeight(editor.getContentHeight());
        editor.onDidContentSizeChange(update);
        update();
      }
    },
    // The mount handler runs once; the auto-height range is fixed per editor.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const resolvedHeight = autoHeight
    ? Math.min(
        Math.max(contentHeight ?? autoHeight.min * lineHeight + 12, autoHeight.min * lineHeight + 12),
        autoHeight.max * lineHeight + 12,
      )
    : (height ?? '100%');

  return (
    <Box
      sx={{
        position: 'relative',
        height: resolvedHeight,
        minHeight: 0,
        border: 1,
        borderColor: 'divider',
        borderRadius: 1,
        overflow: 'hidden',
        bgcolor: dark ? '#1e1e1e' : '#fff',
        '&:focus-within': { borderColor: 'primary.main' },
      }}
    >
      <Editor
        value={value}
        language={language === 'shell' ? 'shell' : language}
        theme={dark ? 'vs-dark' : 'light'}
        path={modelPath}
        onChange={(next) => onChange?.(next ?? '')}
        onMount={handleMount}
        loading={null}
        options={{
          ...BASE_OPTIONS,
          readOnly,
          domReadOnly: readOnly,
          lineNumbers: lineNumbers ? 'on' : 'off',
          lineNumbersMinChars: 3,
          glyphMargin: false,
          lineDecorationsWidth: lineNumbers ? 6 : 2,
          ariaLabel,
          ...(autoHeight ? { scrollbar: { ...BASE_OPTIONS.scrollbar, vertical: 'auto' as const } } : {}),
        }}
      />
      {placeholder && !value && (
        <Box
          aria-hidden
          sx={{
            position: 'absolute',
            top: 6,
            left: lineNumbers ? 48 : 12,
            right: 12,
            pointerEvents: 'none',
            color: 'text.disabled',
            fontFamily: '"JetBrains Mono", monospace',
            fontSize: 12.5,
            lineHeight: `${lineHeight}px`,
            whiteSpace: 'pre-wrap',
          }}
        >
          {placeholder}
        </Box>
      )}
    </Box>
  );
}

export function DiffViewer({
  original,
  modified,
  language,
  height = '100%',
}: {
  original: string;
  modified: string;
  language: CodeLanguage;
  height?: number | string;
}) {
  const dark = useDarkMode();
  const editorRef = useRef<monaco.editor.IStandaloneDiffEditor | null>(null);
  if (language === 'yang') registerYang();
  // The wrapper disposes its models before the diff widget lets go of them,
  // which Monaco reports as an error. Detach first, then dispose them here.
  useEffect(
    () => () => {
      const editor = editorRef.current;
      if (!editor) return;
      const model = editor.getModel();
      editor.setModel(null);
      model?.original.dispose();
      model?.modified.dispose();
    },
    [],
  );
  return (
    <Box sx={{ height, border: 1, borderColor: 'divider', borderRadius: 1, overflow: 'hidden' }}>
      <DiffEditor
        original={original}
        modified={modified}
        language={language}
        theme={dark ? 'vs-dark' : 'light'}
        loading={null}
        keepCurrentOriginalModel
        keepCurrentModifiedModel
        onMount={(editor) => {
          editorRef.current = editor;
        }}
        options={{
          ...BASE_OPTIONS,
          readOnly: true,
          renderSideBySide: true,
          useInlineViewWhenSpaceIsLimited: true,
          renderSideBySideInlineBreakpoint: 700,
          hideUnchangedRegions: { enabled: true, contextLineCount: 3, minimumLineCount: 5, revealLineCount: 20 },
          ignoreTrimWhitespace: false,
          renderOverviewRuler: true,
        }}
      />
    </Box>
  );
}

/** Keep a stable callback identity while always calling the latest function. */
export function useLatest<T>(value: T): { readonly current: T } {
  const ref = useRef(value);
  useEffect(() => {
    ref.current = value;
  });
  return ref;
}
