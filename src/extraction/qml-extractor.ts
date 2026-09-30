/**
 * QML Extractor
 *
 * Custom extractor for Qt QML declarative UI files.
 *
 * QML files define a component hierarchy with embedded JavaScript.
 * Rather than relying on a tree-sitter WASM grammar, this extractor
 * uses a structured line-by-line parser that tracks nesting depth,
 * exactly as the DFM/Svelte/Vue extractors do.
 *
 * Extracted information:
 *  - `import` statements → `import` nodes + `imports` edges to C++ or QML modules
 *  - Root component type → `component` node (the file IS the component)
 *  - Nested component instantiations (`TypeName { }`) → `component` nodes + `instantiates` edges
 *  - `property T name` declarations → `property` nodes
 *  - `signal name(params)` declarations → `method` nodes
 *  - `function name(…)` declarations → `function` nodes; body delegated to JS extractor
 *  - Signal handler bindings (`onFoo: …`) → `method` nodes (handlers)
 */

import { Node, Edge, ExtractionResult, ExtractionError, UnresolvedReference, Language } from '../types';
import { generateNodeId, getChildByField } from './tree-sitter-helpers';
import { TreeSitterExtractor } from './tree-sitter';
import { getParser, isLanguageSupported } from './grammars';

// Common QtQuick built-in types that are instantiated by users but defined in Qt itself
const QT_BUILTIN_TYPES = new Set([
  'Item', 'Rectangle', 'Text', 'Image', 'MouseArea', 'Column', 'Row', 'Grid',
  'Flow', 'Repeater', 'Loader', 'Timer', 'Animation', 'NumberAnimation',
  'ColorAnimation', 'PropertyAnimation', 'SequentialAnimation', 'ParallelAnimation',
  'State', 'Transition', 'Behavior', 'Connections', 'Component', 'Binding',
  'ListView', 'GridView', 'PathView', 'ScrollView', 'ScrollBar', 'Flickable',
  'TextInput', 'TextEdit', 'FocusScope', 'Keys', 'MultiPointTouchArea',
  'PinchArea', 'DropArea', 'Canvas', 'ShaderEffect', 'Window', 'ApplicationWindow',
  'Dialog', 'Popup', 'Drawer', 'Menu', 'MenuItem', 'MenuBar', 'ToolBar',
  'ToolButton', 'Button', 'TextField', 'ComboBox', 'CheckBox', 'RadioButton',
  'Slider', 'SpinBox', 'ProgressBar', 'BusyIndicator', 'Label', 'Frame',
  'GroupBox', 'TabBar', 'TabButton', 'StackView', 'SwipeView', 'PageIndicator',
  'Action', 'ActionGroup', 'ButtonGroup', 'ItemDelegate', 'CheckDelegate',
  'RadioDelegate', 'SwitchDelegate', 'SwipeDelegate', 'RoundButton',
  'AbstractButton', 'Container', 'Control', 'Pane', 'Page', 'StackLayout',
  'ColumnLayout', 'RowLayout', 'GridLayout', 'Layout', 'Shortcut',
  'SystemTrayIcon', 'ClosePolicy', 'SplitView', 'SplitHandle',
  'HorizontalHeaderView', 'VerticalHeaderView', 'TreeView', 'TableView',
  'QtObject', 'WorkerScript', 'XmlListModel', 'XmlRole',
  'PathLine', 'PathCurve', 'PathArc', 'PathSvg', 'PathQuad', 'PathCubic',
  'PathPercent', 'PathAttribute', 'PathAngleArc',
  'PropertyChanges', 'AnchorChanges', 'ParentChange', 'StateChangeScript',
  'AnchorAnimation', 'ParentAnimation', 'PathAnimation', 'PauseAnimation',
  'ScriptAction', 'PropertyAction',
  'Accessible', 'LayoutMirroring', 'TextDocument',
  'QAbstractItemModel',
]);

// ---------------------------------------------------------------------------
// Regex patterns for QML syntax
// ---------------------------------------------------------------------------

/** import QtQuick 2.15 / import "path" / import "script.js" as Alias */
const RE_IMPORT = /^\s*import\s+(.+?)(?:\s+as\s+(\w+))?\s*$/;

/** Component instantiation or grouped property: TypeName { or anchors { */
const RE_COMPONENT = /^\s*([A-Za-z][A-Za-z0-9]*(?:\.[A-Za-z][A-Za-z0-9]*)*)\s*\{/;

const RE_BOUND_COMPONENT = /^\s*[A-Za-z_$][\w$.]*\s*:\s*([A-Z][A-Za-z0-9]*(?:\.[A-Za-z][A-Za-z0-9]*)*)\s*\{/;

/** property [readonly] [required] T name [: value] */
const RE_PROPERTY = /^\s*(?:(?:readonly|required|default|final|virtual|override)\s+)*property\s+(\S+(?:<[^>]+>)?)\s+(\w+)/;

/** signal name[(params)] */
const RE_SIGNAL = /^\s*signal\s+(\w+)\s*(?:\(([^)]*)\))?/;

/** function name(params) */
const RE_FUNCTION = /^\s*function\s+(\w+)\s*\(([^)]*)\)/;

/** Signal handler binding: onFoo: or onFoo { */
const RE_HANDLER = /^\s*(on[A-Z][A-Za-z0-9.]*)\s*[:{]/;

/** Attached type signal handler: TypeName.onFoo: or TypeName.onFoo { */
const RE_ATTACHED_HANDLER = /^\s*([A-Z][A-Za-z0-9]*)\.(on[A-Z][A-Za-z0-9]*)\s*[:{]/;

/** Inline component declaration (QML 6): component Name: BaseType { */
const RE_INLINE_COMPONENT = /^\s*component\s+([A-Z][A-Za-z0-9]*)\s*:\s*([A-Z][A-Za-z0-9]*(?:\.[A-Za-z][A-Za-z0-9]*)*)\s*\{/;

/** id: identifier */
const RE_ID = /^\s*id\s*:\s*(\w+)/;

/** Literal Connections target: target: backend */
const RE_CONNECTIONS_TARGET = /^\s*target\s*:\s*([A-Za-z_$][\w$]*)\s*;?\s*$/;

/** Any Connections target assignment, including dynamic expressions. */
const RE_CONNECTIONS_TARGET_ASSIGNMENT = /^\s*target\s*:/;

/** enum declaration inside QML: enum Name { } */
const RE_ENUM = /^\s*enum\s+(\w+)\s*\{/;

/** Closing brace on its own line */
const RE_CLOSE = /^\s*\}/;

// ---------------------------------------------------------------------------

interface ComponentFrame {
  nodeId: string;
  startLine: number;
    depth: number;
  typeName: string;
    ownerName: string;
    isGrouping?: boolean;
  qmlId?: string;
    connectionsTarget?: string;
}

interface QmlLexicalState {
    inBlockComment: boolean;
    quote: '"' | "'" | '`' | null;
    escaped: boolean;
}

interface QmlLexicalLine {
    code: string;
    braces: Array<{ index: number; value: '{' | '}' }>;
}

function scanQmlLine(rawLine: string, state: QmlLexicalState): QmlLexicalLine {
    const code = rawLine.split('');
    const braces: QmlLexicalLine['braces'] = [];

    for (let index = 0; index < rawLine.length; index++) {
        const character = rawLine[index]!;
        const nextCharacter = rawLine[index + 1];

        if (state.inBlockComment) {
            code[index] = ' ';
            if (character === '*' && nextCharacter === '/') {
                code[index + 1] = ' ';
                state.inBlockComment = false;
                index++;
            }
            continue;
        }

        if (state.quote) {
            if (state.escaped) {
                state.escaped = false;
                continue;
            }
            if (character === '\\') {
                state.escaped = true;
                continue;
            }
            if (character === state.quote) state.quote = null;
            continue;
        }

        if (character === '/' && nextCharacter === '/') {
            for (let commentIndex = index; commentIndex < code.length; commentIndex++) code[commentIndex] = ' ';
            break;
        }
        if (character === '/' && nextCharacter === '*') {
            code[index] = ' ';
            code[index + 1] = ' ';
            state.inBlockComment = true;
            index++;
            continue;
        }
        if (character === '"' || character === "'" || character === '`') {
            state.quote = character;
            continue;
        }
        if (character === '{' || character === '}') braces.push({ index, value: character });
    }

    if (state.quote && state.quote !== '`') {
        const continuesOnNextLine = state.escaped;
        state.escaped = false;
        if (!continuesOnNextLine) state.quote = null;
    } else {
        state.escaped = false;
    }

    return { code: code.join(''), braces };
}

function findStructuralBrace(line: QmlLexicalLine, value: '{' | '}', startIndex = 0): number {
    return line.braces.find((brace) => brace.value === value && brace.index >= startIndex)?.index ?? -1;
}

function consumeStructuralBraces(
    line: QmlLexicalLine,
    initialDepth: number,
    startIndex = 0,
): { depth: number; closed: boolean; closingIndex: number } {
    let depth = initialDepth;
    for (const brace of line.braces) {
        if (brace.index < startIndex) continue;
        depth += brace.value === '{' ? 1 : -1;
        if (depth === 0) return { depth, closed: true, closingIndex: brace.index };
    }
    return { depth, closed: false, closingIndex: -1 };
}

export class QmlExtractor {
  private readonly filePath: string;
  private readonly lines: string[];
  private nodes: Node[] = [];
  private edges: Edge[] = [];
  private unresolvedRefs: UnresolvedReference[] = [];
  private errors: ExtractionError[] = [];
    private qmlShadowNames = new Set<string>();
    private jsLocalNames = new Map<string, Set<string>>();
    private jsMemberAccesses: Array<{
        sourceNodeId: string;
        receiver: string;
        member: string;
        line: number;
        column: number;
    }> = [];

  constructor(filePath: string, source: string) {
    this.filePath = filePath;
    this.lines = source.split('\n');
  }

  extract(): ExtractionResult {
    const startTime = Date.now();

    try {
      this.parse();
    } catch (error) {
      this.errors.push({
        message: `QML extraction error: ${error instanceof Error ? error.message : String(error)}`,
        severity: 'error',
        code: 'parse_error',
      });
    }

    return {
      nodes: this.nodes,
      edges: this.edges,
      unresolvedReferences: this.unresolvedRefs,
      errors: this.errors,
      durationMs: Date.now() - startTime,
    };
  }

  // -------------------------------------------------------------------------

  private parse(): void {
    const { lines } = this;

    // Stack of open component frames (one per nesting level)
    const stack: ComponentFrame[] = [];
      const qmlIdTypes = new Map<string, Set<string>>();
      const qmlIdOwners = new Map<string, Set<string>>();
      const qmlIdNodeIds = new Map<string, Set<string>>();
      const connectionsHandlers: Array<{
          nodeId: string;
          handlerName: string;
          line: number;
          frame: ComponentFrame;
      }> = [];

    // The outermost component is named after the .qml file
    const fileName = this.filePath.split(/[/\\]/).pop() ?? this.filePath;
    const componentName = fileName.replace(/\.qml$/i, '');

    // Pending JS function body collector
    let jsBodyLines: string[] = [];
    let jsBodyStartLine = 0;
    let jsBodyDepth = 0;
    let jsFunctionNodeId: string | null = null;
    let jsFunctionParentId: string | null = null;

    // Currently open enum block
    let enumDepth = 0;
    let enumNodeId: string | null = null;
    let enumName = '';

    // Track overall brace depth (lines with excess `{` can open a component)
    let braceBalance = 0;
      const lexicalState: QmlLexicalState = { inBlockComment: false, quote: null, escaped: false };
      const consumeComponentBraces = (lexicalLine: QmlLexicalLine, lineNum: number, startIndex = 0): void => {
          for (const brace of lexicalLine.braces) {
              if (brace.index < startIndex) continue;
              if (brace.value === '{') {
                  braceBalance++;
              } else if (braceBalance > 0) {
                  const frame = stack[stack.length - 1];
                  if (frame?.depth === braceBalance) {
                      stack.pop();
                      const node = !frame.isGrouping && this.nodes.find((candidate) => candidate.id === frame.nodeId);
                      if (node) node.endLine = lineNum;
                  }
                  braceBalance--;
              }
          }
      };
      const closeJsBody = (nodeId: string, lineNum: number, closingIndex: number): void => {
          const node = this.nodes.find((candidate) => candidate.id === nodeId);
          if (node && node.kind !== 'component') {
              node.endLine = lineNum;
              node.endColumn = closingIndex + 1;
          }
      };

    for (let i = 0; i < lines.length; i++) {
      const rawLine = lines[i] ?? '';
      const lineNum = i + 1;
        const lexicalLine = scanQmlLine(rawLine, lexicalState);
        const line = lexicalLine.code;

      // ------------------------------------------------------------------
      // If we are inside a JS function body, collect lines until depth=0
      // ------------------------------------------------------------------
        if (jsFunctionNodeId !== null) {
          const bodyBalance = consumeStructuralBraces(lexicalLine, jsBodyDepth);
          const nextBrace = bodyBalance.closed
              ? lexicalLine.braces.find((brace) => brace.index > bodyBalance.closingIndex)?.index
              : undefined;
          jsBodyLines.push(rawLine.slice(0, nextBrace));
          jsBodyDepth = bodyBalance.depth;
          if (bodyBalance.closed) {
              // End of function body — delegate to JS extractor
              this.extractJsBody(
                  jsBodyLines.join('\n'),
                  jsBodyStartLine,
                  jsFunctionNodeId,
                  jsFunctionParentId ?? (stack[stack.length - 1]?.nodeId ?? ''),
              );
              closeJsBody(jsFunctionNodeId, lineNum, bodyBalance.closingIndex);
              consumeComponentBraces(lexicalLine, lineNum, bodyBalance.closingIndex + 1);
              jsFunctionNodeId = null;
              jsFunctionParentId = null;
              jsBodyLines = [];
        }
        continue;
      }

      // ------------------------------------------------------------------
      // Import statements (top-level only, outside any component block)
      // ------------------------------------------------------------------
      if (braceBalance === 0) {
        const importMatch = line.match(RE_IMPORT);
        if (importMatch) {
          this.handleImport(importMatch[1]!.trim(), importMatch[2], lineNum);
          continue;
        }
      }

      // ------------------------------------------------------------------
      // Inline component declaration (QML 6): component Name: BaseType { ... }
      // Must be checked before RE_COMPONENT since `component` starts lowercase.
      // ------------------------------------------------------------------
      const inlineCompMatch = line.match(RE_INLINE_COMPONENT);
      if (inlineCompMatch) {
        const [, inlineName, baseType] = inlineCompMatch;
        const parentFrame = stack[stack.length - 1];
        const nodeId = generateNodeId(this.filePath, 'component', inlineName!, lineNum);
        const node: Node = {
          id: nodeId,
          kind: 'component',
          name: inlineName!,
          qualifiedName: `${this.filePath}::${inlineName}`,
          filePath: this.filePath,
          language: 'qml',
          startLine: lineNum,
          endLine: lineNum, // patched on close
          startColumn: (line.match(/^\s*/)?.[0].length ?? 0),
          endColumn: 0,
          isExported: true,
          updatedAt: Date.now(),
        };
        this.nodes.push(node);
        if (parentFrame) {
          this.edges.push({ source: parentFrame.nodeId, target: nodeId, kind: 'contains' });
        }
        // extends edge to the base type
        this.unresolvedRefs.push({
          fromNodeId: nodeId,
          referenceName: baseType!,
          referenceKind: 'references',
          line: lineNum,
          column: 0,
          filePath: this.filePath,
          language: 'qml',
        });
          stack.push({ nodeId, startLine: lineNum, depth: braceBalance + 1, typeName: inlineName!, ownerName: inlineName! });
          consumeComponentBraces(lexicalLine, lineNum);
        continue;
      }

      // ------------------------------------------------------------------
      // Track opening braces — detect component instantiations
      // ------------------------------------------------------------------
        const componentMatch = line.match(RE_COMPONENT) ?? line.match(RE_BOUND_COMPONENT);
      if (componentMatch) {
        const typeName = componentMatch[1]!;
        const parentFrame = stack[stack.length - 1];

        if (stack.length === 0) {
          // Root component — this IS the .qml file component
          const nodeId = generateNodeId(this.filePath, 'component', componentName, lineNum);
          const node: Node = {
            id: nodeId,
            kind: 'component',
            name: componentName,
            qualifiedName: `${this.filePath}::${componentName}`,
            filePath: this.filePath,
            language: 'qml',
            startLine: lineNum,
            endLine: lines.length, // will be patched on close
            startColumn: 0,
            endColumn: 0,
            isExported: true,
            updatedAt: Date.now(),
          };
          this.nodes.push(node);
            stack.push({ nodeId, startLine: lineNum, depth: braceBalance + 1, typeName, ownerName: componentName });

          // Emit an `extends` edge: this component extends its root type
          // (unless it's a QtObject or unknown built-in without user interest)
          if (typeName !== componentName) {
            this.unresolvedRefs.push({
              fromNodeId: nodeId,
              referenceName: typeName,
              referenceKind: 'references',
              line: lineNum,
              column: 0,
              filePath: this.filePath,
              language: 'qml',
            });
          }
        } else if (parentFrame) {
          // Nested component — skip anonymous grouping objects (lowercase first
          // letter) and Connections / Behavior that don't represent new types.
          const firstChar = typeName[0];
          if (firstChar && firstChar === firstChar.toUpperCase()) {
            const nodeId = generateNodeId(this.filePath, 'component', `${typeName}@L${lineNum}`, lineNum);
            const node: Node = {
              id: nodeId,
              kind: 'component',
              name: typeName,
              qualifiedName: `${this.filePath}::${typeName}@L${lineNum}`,
              filePath: this.filePath,
              language: 'qml',
              startLine: lineNum,
              endLine: lineNum, // patched on close
              startColumn: (line.match(/^\s*/)?.[0].length ?? 0),
              endColumn: 0,
              updatedAt: Date.now(),
            };
            this.nodes.push(node);

            // contains edge: parent component → nested component
            this.edges.push({
              source: parentFrame.nodeId,
              target: nodeId,
              kind: 'contains',
            });

            // instantiates edge: component file → the Qt/QML type it instantiates
            if (!QT_BUILTIN_TYPES.has(typeName)) {
              this.unresolvedRefs.push({
                fromNodeId: parentFrame.nodeId,
                referenceName: typeName,
                referenceKind: 'references',
                line: lineNum,
                column: 0,
                filePath: this.filePath,
                language: 'qml',
              });
            }

              stack.push({ nodeId, startLine: lineNum, depth: braceBalance + 1, typeName, ownerName: typeName });
          } else {
              stack.push({
                  nodeId: parentFrame.nodeId,
                  startLine: lineNum,
                  depth: braceBalance + 1,
                  typeName: '',
                  ownerName: parentFrame.ownerName,
                  isGrouping: true,
              });
          }
        }

          consumeComponentBraces(lexicalLine, lineNum);
        continue;
      }

      // ------------------------------------------------------------------
      // Enum declaration — extract enum + enum_member nodes
      // ------------------------------------------------------------------
      if (enumDepth === 0) {
        const enumMatch = line.match(RE_ENUM);
        if (enumMatch) {
          enumName = enumMatch[1]!;
          const nodeId = generateNodeId(this.filePath, 'enum', enumName, lineNum);
          enumNodeId = nodeId;
          const currentFrame = stack[stack.length - 1];
          const enumNode: Node = {
            id: nodeId,
            kind: 'enum',
            name: enumName,
            qualifiedName: `${this.filePath}::${enumName}`,
            filePath: this.filePath,
            language: 'qml',
            startLine: lineNum,
            endLine: lineNum,
            startColumn: (line.match(/^\s*/)?.[0].length ?? 0),
            endColumn: 0,
            updatedAt: Date.now(),
          };
          this.nodes.push(enumNode);
          if (currentFrame) {
            this.edges.push({ source: currentFrame.nodeId, target: nodeId, kind: 'contains' });
          }
            enumDepth = 1;

          // Process the rest of the opening line — may contain members and close
            const enumBrace = findStructuralBrace(lexicalLine, '{');
            const afterBrace = line.slice(enumBrace + 1);
          this.extractEnumLineMembers(afterBrace, enumName, nodeId, lineNum);
          // Check if the enum closes on the same line
            const enumBalance = consumeStructuralBraces(lexicalLine, 0, enumBrace);
            enumDepth = enumBalance.depth;
            if (enumBalance.closed) {
                enumNode.endLine = lineNum;
                enumNodeId = null;
                enumDepth = 0;
                consumeComponentBraces(lexicalLine, lineNum, enumBalance.closingIndex + 1);
          }
          continue;
        }
      } else {
        // Track depth and extract enum members
          const enumBalance = consumeStructuralBraces(lexicalLine, enumDepth);
          enumDepth = enumBalance.depth;
          if (enumBalance.closed) {
              const enumNode = this.nodes.find((n) => n.id === enumNodeId);
              if (enumNode) enumNode.endLine = lineNum;
              enumNodeId = null;
              consumeComponentBraces(lexicalLine, lineNum, enumBalance.closingIndex + 1);
        }
        // Extract member identifier from lines inside the enum body
          if (!enumBalance.closed && enumDepth > 0 && enumNodeId) {
          this.extractEnumLineMembers(line, enumName, enumNodeId, lineNum);
        }
        continue;
      }

      // ------------------------------------------------------------------
      // Closing brace — pop component stack
      // ------------------------------------------------------------------
      if (RE_CLOSE.test(line) && braceBalance > 0) {
          consumeComponentBraces(lexicalLine, lineNum);
        continue;
      }

      // ------------------------------------------------------------------
      // Content inside a component block
      // ------------------------------------------------------------------
      const currentFrame = stack[stack.length - 1];
      if (!currentFrame) continue;

      // id: identifier
      const idMatch = line.match(RE_ID);
      if (idMatch) {
        currentFrame.qmlId = idMatch[1];
          const types = qmlIdTypes.get(idMatch[1]!) ?? new Set<string>();
          types.add(currentFrame.typeName);
          qmlIdTypes.set(idMatch[1]!, types);
          const owners = qmlIdOwners.get(idMatch[1]!) ?? new Set<string>();
          owners.add(currentFrame.ownerName);
          qmlIdOwners.set(idMatch[1]!, owners);
          const nodeIds = qmlIdNodeIds.get(idMatch[1]!) ?? new Set<string>();
          nodeIds.add(currentFrame.nodeId);
          qmlIdNodeIds.set(idMatch[1]!, nodeIds);
        // Patch the node name to include the QML id for clarity
        const node = this.nodes.find((n) => n.id === currentFrame.nodeId);
        if (node && node.name !== componentName) {
          // For nested nodes, enrich qualifiedName with the id
          node.qualifiedName = `${this.filePath}::${idMatch[1]}(${currentFrame.typeName})`;
        }
        continue;
      }

        if (currentFrame.typeName === 'Connections' && RE_CONNECTIONS_TARGET_ASSIGNMENT.test(line)) {
            currentFrame.connectionsTarget = line.match(RE_CONNECTIONS_TARGET)?.[1];
            continue;
        }

      // property T name [: value]
      const propMatch = line.match(RE_PROPERTY);
      if (propMatch) {
        const [, propType, propName] = propMatch;
          this.qmlShadowNames.add(propName!);
        const nodeId = generateNodeId(this.filePath, 'property', propName!, lineNum);
        const node: Node = {
          id: nodeId,
          kind: 'property',
          name: propName!,
          qualifiedName: `${this.filePath}::${propName}`,
          filePath: this.filePath,
          language: 'qml',
          startLine: lineNum,
          endLine: lineNum,
          startColumn: (line.match(/^\s*/)?.[0].length ?? 0),
          endColumn: line.length,
          signature: `property ${propType} ${propName}`,
          updatedAt: Date.now(),
        };
        this.nodes.push(node);
        this.edges.push({ source: currentFrame.nodeId, target: nodeId, kind: 'contains' });
          const initializerColumn = line.indexOf(':', propMatch[0].length);
          if (initializerColumn >= 0) {
              const bodyBalance = consumeStructuralBraces(lexicalLine, 0, initializerColumn + 1);
              const nextBrace = bodyBalance.closed
                  ? lexicalLine.braces.find((brace) => brace.index > bodyBalance.closingIndex)?.index
                  : undefined;
              const initializer = rawLine.slice(initializerColumn + 1, nextBrace);
              if (bodyBalance.depth > 0) {
                  jsFunctionNodeId = nodeId;
                  jsFunctionParentId = currentFrame.nodeId;
                  jsBodyStartLine = lineNum;
                  jsBodyLines = [initializer];
                  jsBodyDepth = bodyBalance.depth;
              } else {
                  this.extractJsBody(initializer, lineNum, nodeId, currentFrame.nodeId);
                  if (bodyBalance.closed) {
                      consumeComponentBraces(lexicalLine, lineNum, bodyBalance.closingIndex + 1);
                  }
              }
          }
        continue;
      }

      // signal name(params)
      const signalMatch = line.match(RE_SIGNAL);
      if (signalMatch) {
        const [, sigName, sigParams] = signalMatch;
        const nodeId = generateNodeId(this.filePath, 'method', sigName!, lineNum);
        const node: Node = {
          id: nodeId,
          kind: 'method',
          name: sigName!,
          qualifiedName: `${this.filePath}::${sigName}`,
          filePath: this.filePath,
          language: 'qml',
          startLine: lineNum,
          endLine: lineNum,
          startColumn: (line.match(/^\s*/)?.[0].length ?? 0),
          endColumn: line.length,
          signature: `signal ${sigName}(${sigParams ?? ''})`,
          updatedAt: Date.now(),
        };
        this.nodes.push(node);
        this.edges.push({ source: currentFrame.nodeId, target: nodeId, kind: 'contains' });
        continue;
      }

      // function name(params) { ... }
      const funcMatch = line.match(RE_FUNCTION);
      if (funcMatch) {
        const [, funcName, funcParams] = funcMatch;
          const isConnectionsHandler =
              currentFrame.typeName === 'Connections' && /^on[A-Z][A-Za-z0-9]*$/.test(funcName!);
          const nodeId = generateNodeId(this.filePath, isConnectionsHandler ? 'method' : 'function', funcName!, lineNum);
          const parameterNames = new Set(
              (funcParams ?? '')
                  .split(',')
                  .map((parameter) => parameter.trim().split('=')[0]!.trim())
                  .filter((parameter) => /^[A-Za-z_$][\w$]*$/.test(parameter)),
          );
          this.jsLocalNames.set(nodeId, parameterNames);
        const node: Node = {
          id: nodeId,
            kind: isConnectionsHandler ? 'method' : 'function',
          name: funcName!,
          qualifiedName: `${this.filePath}::${funcName}`,
          filePath: this.filePath,
          language: 'qml',
          startLine: lineNum,
          endLine: lineNum, // patched when body ends
          startColumn: (line.match(/^\s*/)?.[0].length ?? 0),
          endColumn: 0,
            signature: isConnectionsHandler
                ? `handler ${funcName}`
                : `function ${funcName}(${funcParams ?? ''})`,
          updatedAt: Date.now(),
        };
        this.nodes.push(node);
        this.edges.push({ source: currentFrame.nodeId, target: nodeId, kind: 'contains' });
          if (isConnectionsHandler) {
              connectionsHandlers.push({ nodeId, handlerName: funcName!, line: lineNum, frame: currentFrame });
          }

        // Start collecting the function body for JS extraction
          const braceInLine = findStructuralBrace(
              lexicalLine,
              '{',
              (funcMatch.index ?? 0) + funcMatch[0].length,
          );
        if (braceInLine >= 0) {
          jsFunctionNodeId = nodeId;
          jsFunctionParentId = currentFrame.nodeId;
          jsBodyStartLine = lineNum;
          jsBodyLines = [rawLine.slice(braceInLine)];
            const bodyBalance = consumeStructuralBraces(lexicalLine, 0, braceInLine);
            jsBodyDepth = bodyBalance.depth;
            if (bodyBalance.closed) {
                this.extractJsBody(rawLine.slice(braceInLine, bodyBalance.closingIndex + 1), jsBodyStartLine, nodeId, currentFrame.nodeId);
                closeJsBody(nodeId, lineNum, bodyBalance.closingIndex);
                consumeComponentBraces(lexicalLine, lineNum, bodyBalance.closingIndex + 1);
                jsFunctionNodeId = null;
              jsFunctionParentId = null;
              jsBodyLines = [];
          }
        }
        continue;
      }

      // Signal handler: onFoo: or onFoo {
      const handlerMatch = line.match(RE_HANDLER);
      if (handlerMatch) {
        const handlerName = handlerMatch[1]!;
          const handlerNodeId = generateNodeId(this.filePath, 'method', handlerName, lineNum);
        // Skip generic "on" properties that aren't signal handlers
          if (handlerName.length > 2) {
          const node: Node = {
              id: handlerNodeId,
            kind: 'method',
            name: handlerName,
            qualifiedName: `${this.filePath}::${handlerName}`,
            filePath: this.filePath,
            language: 'qml',
            startLine: lineNum,
            endLine: lineNum,
            startColumn: (line.match(/^\s*/)?.[0].length ?? 0),
            endColumn: line.length,
            signature: `handler ${handlerName}`,
            updatedAt: Date.now(),
          };
          this.nodes.push(node);
            this.edges.push({ source: currentFrame.nodeId, target: handlerNodeId, kind: 'contains' });

          // Derive the signal name from the handler: onFoo → foo, onFooChanged → fooChanged
          const signalName = handlerName[2]!.toLowerCase() + handlerName.slice(3);
              if (currentFrame.typeName === 'Connections') {
                  connectionsHandlers.push({ nodeId: handlerNodeId, handlerName, line: lineNum, frame: currentFrame });
              } else {
                this.unresolvedRefs.push({
              fromNodeId: handlerNodeId,
            referenceName: signalName,
              referenceKind: 'references',
            line: lineNum,
            column: 0,
            filePath: this.filePath,
            language: 'qml',
              candidates: [`${currentFrame.ownerName}::${signalName}`],
              });
            }
        }
          // Handle block and arrow-function handler bodies as embedded JS.
          const braceInLine = findStructuralBrace(lexicalLine, '{', handlerMatch.index ?? 0);
          if (braceInLine >= 0) {
          jsFunctionNodeId = handlerNodeId;
          jsFunctionParentId = currentFrame.nodeId;
          jsBodyStartLine = lineNum;
          jsBodyLines = [rawLine.slice(braceInLine)];
              const bodyBalance = consumeStructuralBraces(lexicalLine, 0, braceInLine);
              jsBodyDepth = bodyBalance.depth;
              if (bodyBalance.closed) {
                  this.extractJsBody(rawLine.slice(braceInLine, bodyBalance.closingIndex + 1), jsBodyStartLine, handlerNodeId, currentFrame.nodeId);
                  closeJsBody(handlerNodeId, lineNum, bodyBalance.closingIndex);
                  consumeComponentBraces(lexicalLine, lineNum, bodyBalance.closingIndex + 1);
                  jsFunctionNodeId = null;
              jsFunctionParentId = null;
              jsBodyLines = [];
          }
          } else {
              const colonInLine = line.indexOf(':');
              if (colonInLine >= 0) {
                  this.extractJsBody(rawLine.slice(colonInLine + 1), lineNum, handlerNodeId, currentFrame.nodeId);
              }
        }
        continue;
      }

      // Attached type signal handler: TypeName.onFoo: or TypeName.onFoo {
      // e.g. Component.onCompleted, Keys.onPressed, Layout.onChildrenChanged
      const attachedMatch = line.match(RE_ATTACHED_HANDLER);
      if (attachedMatch) {
        const [, attachedType, handlerName] = attachedMatch;
        const fullName = `${attachedType}.${handlerName}`;
        const nodeId = generateNodeId(this.filePath, 'method', fullName, lineNum);
        const node: Node = {
          id: nodeId,
          kind: 'method',
          name: fullName,
          qualifiedName: `${this.filePath}::${fullName}`,
          filePath: this.filePath,
          language: 'qml',
          startLine: lineNum,
          endLine: lineNum,
          startColumn: (line.match(/^\s*/)?.[0].length ?? 0),
          endColumn: line.length,
          signature: `handler ${fullName}`,
          updatedAt: Date.now(),
        };
        this.nodes.push(node);
        this.edges.push({ source: currentFrame.nodeId, target: nodeId, kind: 'contains' });

        // Emit reference to the underlying signal name (strip "on" prefix and lowercase)
        const signalName = handlerName![2]!.toLowerCase() + handlerName!.slice(3);
        this.unresolvedRefs.push({
          fromNodeId: nodeId,
          referenceName: signalName,
            referenceKind: 'references',
          line: lineNum,
          column: 0,
          filePath: this.filePath,
          language: 'qml',
            candidates: [`${attachedType}::${signalName}`],
        });
          // Built-in attached types are defined by Qt, not by project components.
          if (!QT_BUILTIN_TYPES.has(attachedType!)) {
              this.unresolvedRefs.push({
                  fromNodeId: nodeId,
                  referenceName: attachedType!,
                  referenceKind: 'references',
                  line: lineNum,
                  column: 0,
                  filePath: this.filePath,
                  language: 'qml',
              });
          }

          const braceInLine = findStructuralBrace(lexicalLine, '{', attachedMatch.index ?? 0);
          if (braceInLine >= 0) {
              jsFunctionNodeId = nodeId;
              jsFunctionParentId = currentFrame.nodeId;
              jsBodyStartLine = lineNum;
              jsBodyLines = [rawLine.slice(braceInLine)];
              const bodyBalance = consumeStructuralBraces(lexicalLine, 0, braceInLine);
              jsBodyDepth = bodyBalance.depth;
              if (bodyBalance.closed) {
                  this.extractJsBody(rawLine.slice(braceInLine, bodyBalance.closingIndex + 1), jsBodyStartLine, nodeId, currentFrame.nodeId);
                  closeJsBody(nodeId, lineNum, bodyBalance.closingIndex);
                  consumeComponentBraces(lexicalLine, lineNum, bodyBalance.closingIndex + 1);
                  jsFunctionNodeId = null;
                  jsFunctionParentId = null;
                  jsBodyLines = [];
              }
          } else {
              const colonInLine = line.indexOf(':');
              if (colonInLine >= 0) {
                  this.extractJsBody(rawLine.slice(colonInLine + 1), lineNum, nodeId, currentFrame.nodeId);
              }
          }
        continue;
      }

      // ------------------------------------------------------------------
      // Any remaining lines with a { that we haven't matched as a component
      // still increment the brace balance so the stack stays correct.
      // ------------------------------------------------------------------
        const bindingMatch = line.match(/^\s*[A-Za-z_$][\w$.]*\s*:/);
        if (bindingMatch && findStructuralBrace(lexicalLine, '{', bindingMatch[0].length) >= 0) {
            const bodyBalance = consumeStructuralBraces(lexicalLine, 0, bindingMatch[0].length);
            const nextBrace = bodyBalance.closed
                ? lexicalLine.braces.find((brace) => brace.index > bodyBalance.closingIndex)?.index
                : undefined;
            const body = rawLine.slice(bindingMatch[0].length, nextBrace);
            if (bodyBalance.depth > 0) {
                jsFunctionNodeId = currentFrame.nodeId;
                jsFunctionParentId = currentFrame.nodeId;
                jsBodyStartLine = lineNum;
                jsBodyLines = [body];
                jsBodyDepth = bodyBalance.depth;
            } else {
                this.extractJsBody(body, lineNum, currentFrame.nodeId, currentFrame.nodeId);
                consumeComponentBraces(lexicalLine, lineNum, bodyBalance.closingIndex + 1);
          }
          continue;
      }
        consumeComponentBraces(lexicalLine, lineNum);
    }

      this.linkConnectionsSignalHandlers(connectionsHandlers, qmlIdOwners, qmlIdNodeIds);
      this.linkLocalComponentFactories(qmlIdTypes, qmlIdNodeIds);
      this.annotateQmlMemberReferences(qmlIdOwners, qmlIdNodeIds);
      this.linkLocalEnumAccesses();

    // Patch root component endLine to cover the whole file
      {
          const root = this.nodes.find((node) => node.kind === 'component' && node.name === componentName);
      if (root && root.startLine > 0) {
        root.endLine = lines.length;
      }
    }
  }

  // -------------------------------------------------------------------------
  // Import handling
  // -------------------------------------------------------------------------
  // Enum member helper — extract identifiers from a fragment of enum body text
  // (handles both single-line `{ A, B, C }` and multi-line member lines).
  // -------------------------------------------------------------------------

  private extractEnumLineMembers(fragment: string, eName: string, eNodeId: string, lineNum: number): void {
    // Split on commas and closing braces, take only word tokens
    const tokens = fragment.replace(/\{/g, '').replace(/\}/g, '').split(',');
    for (const tok of tokens) {
      // May contain `= value` assignments — strip them
      const memberName = tok.replace(/=.*$/, '').trim().split(/\s+/)[0];
      if (!memberName || !/^\w+$/.test(memberName)) continue;
      const memberId = generateNodeId(this.filePath, 'enum_member', `${eName}.${memberName}`, lineNum);
      this.nodes.push({
        id: memberId,
        kind: 'enum_member',
        name: memberName,
        qualifiedName: `${this.filePath}::${eName}::${memberName}`,
        filePath: this.filePath,
        language: 'qml',
        startLine: lineNum,
        endLine: lineNum,
        startColumn: 0,
        endColumn: 0,
        updatedAt: Date.now(),
      });
      this.edges.push({ source: eNodeId, target: memberId, kind: 'contains' });
    }
  }

  // -------------------------------------------------------------------------

  private handleImport(source: string, alias: string | undefined, lineNum: number): void {
    // Normalize: strip version specifier (e.g. "QtQuick 2.15" → "QtQuick")
    const cleanSource = source.replace(/\s+\d+(?:\.\d+)?$/, '').replace(/^["']|["']$/g, '');
    const moduleName = cleanSource;
    const importText = alias ? `import ${source} as ${alias}` : `import ${source}`;
      if (alias) this.qmlShadowNames.add(alias);

    const nodeId = generateNodeId(this.filePath, 'import', moduleName, lineNum);
    const node: Node = {
      id: nodeId,
      kind: 'import',
      name: moduleName,
      qualifiedName: `${this.filePath}::import::${moduleName}`,
      filePath: this.filePath,
      language: 'qml',
      startLine: lineNum,
      endLine: lineNum,
      startColumn: 0,
      endColumn: importText.length,
      signature: importText,
      updatedAt: Date.now(),
    };
    this.nodes.push(node);

    // Unresolved reference so the resolution pass can link to the C++ module or
    // another QML component directory.
    this.unresolvedRefs.push({
      fromNodeId: nodeId,
      referenceName: moduleName,
      referenceKind: 'imports',
      line: lineNum,
      column: 0,
      filePath: this.filePath,
      language: 'qml',
    });
  }

  // -------------------------------------------------------------------------
  // JS body delegation
  // -------------------------------------------------------------------------

    private linkConnectionsSignalHandlers(
        handlers: Array<{ nodeId: string; handlerName: string; line: number; frame: ComponentFrame }>,
        qmlIdOwners: Map<string, Set<string>>,
        qmlIdNodeIds: Map<string, Set<string>>,
    ): void {
        for (const handler of handlers) {
            const targetId = handler.frame.connectionsTarget;
            if (!targetId) continue;
            const owners = qmlIdOwners.get(targetId);
            const nodeIds = qmlIdNodeIds.get(targetId);
            const signalName = handler.handlerName[2]!.toLowerCase() + handler.handlerName.slice(3);
            let candidate: string;
            if (owners) {
                if (owners.size !== 1 || nodeIds?.size !== 1) continue;
                candidate = `${[...owners][0]!}::${signalName}`;
            } else {
                if (this.qmlShadowNames.has(targetId)) continue;
                candidate = `qt.context-signal|${targetId}|${signalName}`;
            }
            this.unresolvedRefs.push({
                fromNodeId: handler.nodeId,
                referenceName: signalName,
                referenceKind: 'references',
                line: handler.line,
                column: 0,
                filePath: this.filePath,
                language: 'qml',
                candidates: [candidate],
            });
        }
    }

    private annotateQmlMemberReferences(
        qmlIdOwners: Map<string, Set<string>>,
        qmlIdNodeIds: Map<string, Set<string>>,
    ): void {
        for (const ref of this.unresolvedRefs) {
            if (ref.referenceKind !== 'calls') continue;
            const memberCall = ref.referenceName.match(/^([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)$/);
            if (!memberCall) continue;
            const [, receiver, methodName] = memberCall;
            if (this.jsLocalNames.get(ref.fromNodeId)?.has(receiver!)) continue;
            const owners = qmlIdOwners.get(receiver!);
            let candidate: string;
            if (owners?.size === 1 && qmlIdNodeIds.get(receiver!)?.size === 1) {
                const ownerName = [...owners][0]!;
                candidate = `qt.qml-id|${receiver}|${ownerName}|${methodName}`;
            } else {
                if (
                    owners ||
                    this.qmlShadowNames.has(receiver!)
                ) continue;
                candidate = `qt.context-property|${receiver}|${methodName}`;
            }
            if (!ref.candidates?.includes(candidate)) {
                ref.candidates = [...(ref.candidates ?? []), candidate];
            }
        }
    }

    private linkLocalComponentFactories(
        qmlIdTypes: Map<string, Set<string>>,
        qmlIdNodeIds: Map<string, Set<string>>,
    ): void {
        const nodesById = new Map(this.nodes.map((node) => [node.id, node]));
        for (const ref of this.unresolvedRefs) {
            if (ref.referenceKind !== 'calls') continue;
            const call = ref.referenceName.match(/^([A-Za-z_$][\w$]*)\.createObject$/);
            if (!call) continue;
            const receiver = call[1]!;
            const types = qmlIdTypes.get(receiver);
            const factoryNodeIds = qmlIdNodeIds.get(receiver);
            if (types?.size !== 1 || !types.has('Component') || factoryNodeIds?.size !== 1) continue;
            const factoryNodeId = [...factoryNodeIds][0]!;
            const children = this.edges
                .filter((edge) => edge.kind === 'contains' && edge.source === factoryNodeId)
                .map((edge) => nodesById.get(edge.target))
                .filter((node): node is Node => node?.kind === 'component');
            if (children.length !== 1) continue;
            this.edges.push({ source: ref.fromNodeId, target: children[0]!.id, kind: 'instantiates' });
        }
    }

    private linkLocalEnumAccesses(): void {
        const members = new Map<string, Node[]>();
        for (const node of this.nodes) {
            if (node.kind !== 'enum_member') continue;
            const parts = node.qualifiedName.split('::');
            if (parts.length < 3) continue;
            const key = `${parts.at(-2)}.${parts.at(-1)}`;
            members.set(key, [...(members.get(key) ?? []), node]);
        }
        const emitted = new Set<string>();
        for (const access of this.jsMemberAccesses) {
            const targets = members.get(`${access.receiver}.${access.member}`);
            if (targets) {
                if (targets.length !== 1) continue;
                const target = targets[0]!;
                const key = `${access.sourceNodeId}|${target.id}`;
                if (emitted.has(key)) continue;
                emitted.add(key);
                this.edges.push({ source: access.sourceNodeId, target: target.id, kind: 'references' });
                continue;
            }
            if (
                this.qmlShadowNames.has(access.receiver) ||
                this.jsLocalNames.get(access.sourceNodeId)?.has(access.receiver)
            ) continue;
            const ownerLeaf = access.receiver.split('.').at(-1)!;
            if (!/^[A-Z]/.test(ownerLeaf)) continue;
            const candidate = `qt.enum-member|${access.receiver.replaceAll('.', '::')}|${access.member}`;
            const key = `${access.sourceNodeId}|${candidate}`;
            if (emitted.has(key)) continue;
            emitted.add(key);
            this.unresolvedRefs.push({
                fromNodeId: access.sourceNodeId,
                referenceName: access.member,
                referenceKind: 'references',
                line: access.line,
                column: access.column,
                filePath: this.filePath,
                language: 'qml',
                candidates: [candidate],
            });
        }
    }

  private extractJsBody(
    body: string,
    startLine: number,
    functionNodeId: string,
    _parentNodeId: string,
  ): void {
    const lang: Language = 'javascript';
    if (!isLanguageSupported(lang)) return;

    try {
      const extractor = new TreeSitterExtractor(this.filePath, body, lang);
      const result = extractor.extract();
        const parser = getParser(lang);
        const tree = parser?.parse(body);
        for (const memberExpression of tree?.rootNode.descendantsOfType('member_expression') ?? []) {
            if (
                memberExpression.parent?.type === 'call_expression' ||
                memberExpression.parent?.type === 'member_expression'
            ) continue;
            const receiver = getChildByField(memberExpression, 'object');
            const member = getChildByField(memberExpression, 'property');
            if (
                (receiver?.type !== 'identifier' && receiver?.type !== 'member_expression') ||
                member?.type !== 'property_identifier' ||
                !/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/.test(receiver.text)
            ) continue;
            this.jsMemberAccesses.push({
                sourceNodeId: functionNodeId,
                receiver: receiver.text,
                member: member.text,
                line: member.startPosition.row + startLine,
                column: member.startPosition.column,
            });
        }

        const localNames = this.jsLocalNames.get(functionNodeId) ?? new Set<string>();
        for (const node of result.nodes) {
            if (node.kind === 'variable' || node.kind === 'parameter') localNames.add(node.name);
        }
        for (const declaration of tree?.rootNode.descendantsOfType('variable_declarator') ?? []) {
            const name = getChildByField(declaration, 'name');
            if (name?.type === 'identifier') localNames.add(name.text);
        }
        this.jsLocalNames.set(functionNodeId, localNames);

      for (const ref of result.unresolvedReferences) {
        // Offset lines back to the .qml file positions
        this.unresolvedRefs.push({
          ...ref,
          fromNodeId: functionNodeId,
          line: ref.line + startLine - 1,
          language: 'qml',
        });
      }
    } catch {
      // Silently skip JS parse errors inside QML — the QML extraction itself
      // is still valid; only intra-body call edges are lost.
    }
  }
}
