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
import { generateNodeId } from './tree-sitter-helpers';
import { TreeSitterExtractor } from './tree-sitter';
import { isLanguageSupported } from './grammars';

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

/** Component instantiation: TypeName { or Qualified.Type { */
const RE_COMPONENT = /^\s*([A-Z][A-Za-z0-9]*(?:\.[A-Za-z][A-Za-z0-9]*)*)\s*\{/;

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

/** enum declaration inside QML: enum Name { } */
const RE_ENUM = /^\s*enum\s+(\w+)\s*\{/;

/** Closing brace on its own line */
const RE_CLOSE = /^\s*\}/;

// ---------------------------------------------------------------------------

interface ComponentFrame {
  nodeId: string;
  startLine: number;
  typeName: string;
  qmlId?: string;
}

export class QmlExtractor {
  private readonly filePath: string;
  private readonly lines: string[];
  private nodes: Node[] = [];
  private edges: Edge[] = [];
  private unresolvedRefs: UnresolvedReference[] = [];
  private errors: ExtractionError[] = [];

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

    // The outermost component is named after the .qml file
    const fileName = this.filePath.split(/[/\\]/).pop() ?? this.filePath;
    const componentName = fileName.replace(/\.qml$/i, '');

    // Track line numbers for block-close detection
    const braceDepth: number[] = []; // open-brace lines for each frame

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

    for (let i = 0; i < lines.length; i++) {
      const rawLine = lines[i] ?? '';
      const lineNum = i + 1;

      // ------------------------------------------------------------------
      // Strip inline // comments for pattern matching (but keep the line
      // length by replacing with spaces to preserve column positions).
      // Simple heuristic — doesn't handle comments inside strings.
      // ------------------------------------------------------------------
      const commentIdx = rawLine.indexOf('//');
      const line = commentIdx >= 0 ? rawLine.slice(0, commentIdx) : rawLine;

      // ------------------------------------------------------------------
      // If we are inside a JS function body, collect lines until depth=0
      // ------------------------------------------------------------------
      if (jsFunctionNodeId !== null) {
        jsBodyLines.push(rawLine);
        for (const ch of rawLine) {
          if (ch === '{') jsBodyDepth++;
          else if (ch === '}') {
            jsBodyDepth--;
            if (jsBodyDepth === 0) {
              // End of function body — delegate to JS extractor
              this.extractJsBody(
                jsBodyLines.join('\n'),
                jsBodyStartLine,
                jsFunctionNodeId,
                jsFunctionParentId ?? (stack[stack.length - 1]?.nodeId ?? ''),
              );
              jsFunctionNodeId = null;
              jsFunctionParentId = null;
              jsBodyLines = [];
              break;
            }
          }
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
        stack.push({ nodeId, startLine: lineNum, typeName: inlineName! });
        braceBalance++;
        braceDepth.push(lineNum);
        continue;
      }

      // ------------------------------------------------------------------
      // Track opening braces — detect component instantiations
      // ------------------------------------------------------------------
      const componentMatch = line.match(RE_COMPONENT);
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
          stack.push({ nodeId, startLine: lineNum, typeName });

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

            stack.push({ nodeId, startLine: lineNum, typeName });
          } else {
            stack.push({ nodeId: parentFrame.nodeId, startLine: lineNum, typeName: '' });
          }
        }

        braceBalance++;
        braceDepth.push(lineNum);
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
          braceBalance++;

          // Process the rest of the opening line — may contain members and close
          const afterBrace = line.slice(line.indexOf('{') + 1);
          this.extractEnumLineMembers(afterBrace, enumName, nodeId, lineNum);
          // Check if the enum closes on the same line
          let depth = 1;
          for (const ch of afterBrace) {
            if (ch === '{') depth++;
            else if (ch === '}') {
              depth--;
              if (depth === 0) {
                enumNode.endLine = lineNum;
                enumNodeId = null;
                enumDepth = 0;
                braceBalance--;
                break;
              }
            }
          }
          continue;
        }
      } else {
        // Track depth and extract enum members
        let closed = false;
        for (const ch of line) {
          if (ch === '{') enumDepth++;
          else if (ch === '}') {
            enumDepth--;
            if (enumDepth === 0) {
              const enumNode = this.nodes.find((n) => n.id === enumNodeId);
              if (enumNode) enumNode.endLine = lineNum;
              enumNodeId = null;
              braceBalance--;
              closed = true;
              break;
            }
          }
        }
        // Extract member identifier from lines inside the enum body
        if (!closed && enumDepth > 0 && enumNodeId) {
          this.extractEnumLineMembers(line, enumName, enumNodeId, lineNum);
        }
        continue;
      }

      // ------------------------------------------------------------------
      // Closing brace — pop component stack
      // ------------------------------------------------------------------
      if (RE_CLOSE.test(line) && braceBalance > 0) {
        braceBalance--;
        braceDepth.pop();

        if (stack.length > 0) {
          const frame = stack[stack.length - 1]!;
          // Patch the endLine of the corresponding node
          const node = this.nodes.find((n) => n.id === frame.nodeId);
          if (node && node.endLine === (node.startLine)) {
            node.endLine = lineNum;
          } else if (node && node.endLine > node.startLine) {
            // root component — leave it, already covers file
          }
          stack.pop();
        }
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
        // Patch the node name to include the QML id for clarity
        const node = this.nodes.find((n) => n.id === currentFrame.nodeId);
        if (node && node.name !== componentName) {
          // For nested nodes, enrich qualifiedName with the id
          node.qualifiedName = `${this.filePath}::${idMatch[1]}(${currentFrame.typeName})`;
        }
        continue;
      }

      // property T name [: value]
      const propMatch = line.match(RE_PROPERTY);
      if (propMatch) {
        const [, propType, propName] = propMatch;
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
        const nodeId = generateNodeId(this.filePath, 'function', funcName!, lineNum);
        const node: Node = {
          id: nodeId,
          kind: 'function',
          name: funcName!,
          qualifiedName: `${this.filePath}::${funcName}`,
          filePath: this.filePath,
          language: 'qml',
          startLine: lineNum,
          endLine: lineNum, // patched when body ends
          startColumn: (line.match(/^\s*/)?.[0].length ?? 0),
          endColumn: 0,
          signature: `function ${funcName}(${funcParams ?? ''})`,
          updatedAt: Date.now(),
        };
        this.nodes.push(node);
        this.edges.push({ source: currentFrame.nodeId, target: nodeId, kind: 'contains' });

        // Start collecting the function body for JS extraction
        const braceInLine = rawLine.indexOf('{');
        if (braceInLine >= 0) {
          jsFunctionNodeId = nodeId;
          jsFunctionParentId = currentFrame.nodeId;
          jsBodyStartLine = lineNum;
          jsBodyLines = [rawLine.slice(braceInLine)];
          jsBodyDepth = 1;
          // count any } on this same line
          for (let ci = braceInLine + 1; ci < rawLine.length; ci++) {
            if (rawLine[ci] === '{') jsBodyDepth++;
            else if (rawLine[ci] === '}') {
              jsBodyDepth--;
              if (jsBodyDepth === 0) {
                this.extractJsBody(jsBodyLines.join('\n'), jsBodyStartLine, nodeId, currentFrame.nodeId);
                jsFunctionNodeId = null;
                break;
              }
            }
          }
        }
        continue;
      }

      // Signal handler: onFoo: or onFoo {
      const handlerMatch = line.match(RE_HANDLER);
      if (handlerMatch) {
        const handlerName = handlerMatch[1]!;
        // Skip generic "on" properties that aren't signal handlers
        if (handlerName.length > 2) {
          const nodeId = generateNodeId(this.filePath, 'method', handlerName, lineNum);
          const node: Node = {
            id: nodeId,
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
          this.edges.push({ source: currentFrame.nodeId, target: nodeId, kind: 'contains' });

          // Derive the signal name from the handler: onFoo → foo, onFooChanged → fooChanged
          const signalName = handlerName[2]!.toLowerCase() + handlerName.slice(3);
          this.unresolvedRefs.push({
            fromNodeId: nodeId,
            referenceName: signalName,
            referenceKind: 'calls',
            line: lineNum,
            column: 0,
            filePath: this.filePath,
            language: 'qml',
          });
        }
        // Handle block handler body — treat as JS if followed by {
        const braceInLine = rawLine.lastIndexOf('{');
        if (braceInLine >= 0 && handlerMatch[0].endsWith('{')) {
          // Multi-line handler body — delegate to JS
          const handlerNodeId = generateNodeId(this.filePath, 'method', handlerName, lineNum);
          jsFunctionNodeId = handlerNodeId;
          jsFunctionParentId = currentFrame.nodeId;
          jsBodyStartLine = lineNum;
          jsBodyLines = [rawLine.slice(braceInLine)];
          jsBodyDepth = 1;
          for (let ci = braceInLine + 1; ci < rawLine.length; ci++) {
            if (rawLine[ci] === '{') jsBodyDepth++;
            else if (rawLine[ci] === '}') {
              jsBodyDepth--;
              if (jsBodyDepth === 0) {
                this.extractJsBody(jsBodyLines.join('\n'), jsBodyStartLine, handlerNodeId, currentFrame.nodeId);
                jsFunctionNodeId = null;
                break;
              }
            }
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
          referenceKind: 'calls',
          line: lineNum,
          column: 0,
          filePath: this.filePath,
          language: 'qml',
        });
        // Also emit reference to the attached type (e.g. Component, Keys)
        this.unresolvedRefs.push({
          fromNodeId: nodeId,
          referenceName: attachedType!,
          referenceKind: 'references',
          line: lineNum,
          column: 0,
          filePath: this.filePath,
          language: 'qml',
        });
        continue;
      }

      // ------------------------------------------------------------------
      // Any remaining lines with a { that we haven't matched as a component
      // still increment the brace balance so the stack stays correct.
      // ------------------------------------------------------------------
      for (const ch of rawLine) {
        if (ch === '{') { braceBalance++; braceDepth.push(lineNum); }
        else if (ch === '}' && braceBalance > 0) {
          braceBalance--;
          braceDepth.pop();
          if (stack.length > 0) {
            const frame = stack[stack.length - 1]!;
            const node = this.nodes.find((n) => n.id === frame.nodeId);
            if (node && node.endLine < lineNum) node.endLine = lineNum;
            // Only pop real component frames, not anonymous binding braces
            // We already handled } on its own line above. Skip here to avoid double-pop.
          }
          break; // one } per line in this fallback
        }
      }
    }

    // Patch root component endLine to cover the whole file
    if (this.nodes.length > 0) {
      const root = this.nodes[0];
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
