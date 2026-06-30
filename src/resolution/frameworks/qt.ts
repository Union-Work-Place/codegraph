/**
 * Qt Framework Resolver
 *
 * Handles Qt-specific C++ and QML patterns:
 *
 * C++ side:
 *  - Extracts `Q_PROPERTY(...)` macro declarations as `property` nodes
 *  - Extracts `signals:` / `Q_SIGNALS:` section declarations as `method` nodes
 *  - Extracts `slots:` / `Q_SLOTS:` section declarations as `method` nodes
 *  - Extracts `Q_INVOKABLE` methods as QML-callable method nodes
 *  - Emits edges for `QObject::connect()` SIGNAL/SLOT macro calls
 *  - Emits edges for modern `connect(&Src, &Src::sig, &Dst, &Dst::slot)` calls
 *  - Extracts `QML_NAMED_ELEMENT(X)` as a `component` alias node
 *  - Detects `qmlRegisterType<T>(uri, maj, min, "QmlName")` and creates alias nodes
 *
 * QML side:
 *  - Resolves QML signal handler names (`onFooChanged`) to C++ `fooChanged` signals
 *  - Resolves QML `import ModuleName` references to C++ modules registered via
 *    `qmlRegisterType` or `Q_DECLARE_QML_ELEMENT`
 */

import * as path from 'path';
import { Node, Language } from '../../types';
import { generateNodeId } from '../../extraction/tree-sitter-helpers';
import {
  FrameworkResolver,
  FrameworkExtractionResult,
  UnresolvedRef,
  ResolvedRef,
  ResolutionContext,
} from '../types';

// ---------------------------------------------------------------------------
// Detection helpers
// ---------------------------------------------------------------------------

/** Header tokens that strongly indicate a Qt C++ file */
const QT_INCLUDE_PATTERN = /^#include\s+[<"](Q[A-Z]\w+|QtCore|QtGui|QtWidgets|QtQuick|QtQml|QApplication|QObject|QWidget)[>"]/m;

/** Q_OBJECT or Q_GADGET inside a class — the definitive Qt class marker */
const Q_OBJECT_PATTERN = /\bQ_(?:OBJECT|GADGET|NAMESPACE|ENUM|FLAG|ENUMS|FLAGS)\b/;

// ---------------------------------------------------------------------------
// C++ extraction patterns
// ---------------------------------------------------------------------------

/**
 * Matches a signals: or Q_SIGNALS: / slots: / Q_SLOTS: section header.
 * Captures the keyword so we know whether we're in signals or slots.
 * Also handles access-qualified forms: `public slots:`, `private slots:`, etc.
 */
const RE_SECTION = /^\s*(?:public\s+|private\s+|protected\s+)?(?:Q_SIGNALS|signals|Q_SLOTS|slots)\s*:/;

/**
 * Detect the section type from a matching line.
 */
function getSectionType(line: string): 'signals' | 'slots' | null {
  if (/\b(?:Q_SIGNALS|signals)\s*:/.test(line)) return 'signals';
  if (/\b(?:Q_SLOTS|slots)\s*:/.test(line)) return 'slots';
  return null;
}

/**
 * Match a function declaration inside a signals:/slots: section.
 * Captures: returnType, methodName, params
 */
const RE_FUNC_DECL = /^\s*(?:Q_INVOKABLE\s+|virtual\s+|override\s+|final\s+)*(\S[\s\S]*?)\s+(\w+)\s*\(([^)]*)\)\s*(?:const\s*)?;/;

/**
 * Q_PROPERTY(type name READ getter [WRITE setter] [NOTIFY signal] [...])
 * The macro can span multiple lines but usually fits on one.
 */
const RE_Q_PROPERTY = /Q_PROPERTY\s*\(\s*([^)]+)\)/g;

/**
 * Signals the connect() call pattern:
 *   QObject::connect(sender, SIGNAL(sig(args)), receiver, SLOT(slot(args)))
 * or new-style:
 *   connect(sender, &ClassName::methodName, receiver, &ClassName::methodName)
 */
const RE_CONNECT_MACRO = /connect\s*\(\s*\w[^,]*,\s*SIGNAL\s*\(\s*(\w+)\s*\([^)]*\)\s*\)\s*,\s*\w[^,]*,\s*SLOT\s*\(\s*(\w+)\s*\([^)]*\)\s*\)/g;
const RE_CONNECT_PTR = /connect\s*\(\s*\w[^,]*,\s*&\s*(\w+)\s*::\s*(\w+)\s*,\s*\w[^,]*,\s*&\s*(\w+)\s*::\s*(\w+)/g;

/**
 * QML_NAMED_ELEMENT(QmlTypeName) — registers the C++ class under a custom QML name.
 * Only the first occurrence per class is used.
 */
const RE_QML_NAMED_ELEMENT = /\bQML_NAMED_ELEMENT\s*\(\s*(\w+)\s*\)/g;

/**
 * QML_ELEMENT — registers the C++ class as a QML element with the same name.
 * Presence is checked during detection to confirm a file uses Qt 6 QML patterns.
 */
const QML_ELEMENT_PATTERN = /\bQML_ELEMENT\b/;

/**
 * qmlRegisterType<CppClass>("uri", major, minor, "QmlName")
 * Captures the C++ type and the QML element name.
 */
const RE_QML_REGISTER_TYPE = /qmlRegisterType\s*<\s*(\w+)\s*>\s*\(\s*"[^"]*"\s*,\s*\d+\s*,\s*\d+\s*,\s*"(\w+)"\s*\)/g;

/**
 * Q_INVOKABLE method declaration outside of signals:/slots: sections.
 * Captures the return type and method name for tagging as invokable.
 */
const RE_Q_INVOKABLE_DECL = /^\s*Q_INVOKABLE\s+(?:(?:virtual|inline|static|explicit|const)\s+)*(\S[\s\S]*?)\s+(\w+)\s*\(([^)]*)\)\s*(?:const\s*)?(?:override\s*)?(?:final\s*)?(?:noexcept\s*)?;/;

/**
 * Matches a class or struct that contains Q_OBJECT/Q_GADGET.
 * Used to associate extracted members with a parent class.
 */
const RE_CLASS_HEADER = /^\s*(?:class|struct)\s+(?:[A-Z][A-Z0-9_]+\s+)?(\w+)\s*(?:final\s*)?(?::\s*[^{]+)?\{/;

// ---------------------------------------------------------------------------
// Q_PROPERTY parsing
// ---------------------------------------------------------------------------

interface QProp {
  type: string;
  name: string;
  read?: string;
  write?: string;
  notify?: string;
}

function parseQProperty(macroBody: string): QProp | null {
  // First token(s) = type, then name, then keyword pairs
  const tokens = macroBody.trim().split(/\s+/);
  if (tokens.length < 2) return null;

  // The type may be multi-word (e.g. "unsigned int", "QList<int>")
  // We detect the name as the last token before the first keyword
  const keywords = new Set(['READ', 'WRITE', 'NOTIFY', 'RESET', 'REVISION', 'DESIGNABLE', 'SCRIPTABLE', 'STORED', 'USER', 'CONSTANT', 'FINAL', 'REQUIRED', 'BINDABLE', 'MEMBER']);

  let nameIdx = -1;
  for (let i = 1; i < tokens.length; i++) {
    if (keywords.has(tokens[i]!)) { nameIdx = i - 1; break; }
  }
  if (nameIdx < 0) nameIdx = tokens.length - 1;

  const name = tokens[nameIdx]!;
  const type = tokens.slice(0, nameIdx).join(' ');

  const result: QProp = { type, name };

  // Parse keyword-value pairs
  for (let i = nameIdx + 1; i < tokens.length - 1; i++) {
    const kw = tokens[i]!;
    const val = tokens[i + 1]!;
    if (kw === 'READ') result.read = val;
    else if (kw === 'WRITE') result.write = val;
    else if (kw === 'NOTIFY') result.notify = val;
  }
  return result;
}

// ---------------------------------------------------------------------------
// Main extractor function
// ---------------------------------------------------------------------------

function extractQtFromCpp(
  filePath: string,
  content: string,
): FrameworkExtractionResult {
  const nodes: Node[] = [];
  const references: UnresolvedRef[] = [];

  // Quick bail-out: not a Qt file
  if (!Q_OBJECT_PATTERN.test(content) && !QT_INCLUDE_PATTERN.test(content)) {
    return { nodes, references };
  }

  const lines = content.split('\n');
  let currentClass: string | null = null;
  let currentSection: 'signals' | 'slots' | null = null;
  let braceDepth = 0;
  let classBraceDepth = -1;

  // ---- pass 1: class + section + member extraction ----
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const lineNum = i + 1;

    // Track brace depth
    for (const ch of line) {
      if (ch === '{') braceDepth++;
      else if (ch === '}') {
        braceDepth--;
        if (braceDepth === classBraceDepth) {
          currentClass = null;
          classBraceDepth = -1;
          currentSection = null;
        }
      }
    }

    // Detect class header
    const classMatch = line.match(RE_CLASS_HEADER);
    if (classMatch && currentClass === null) {
      currentClass = classMatch[1]!;
      classBraceDepth = braceDepth - 1; // depth at open brace
    }

    // Detect section change
    if (RE_SECTION.test(line)) {
      currentSection = getSectionType(line);
      continue;
    }

    // Reset section on any access specifier (public:, private:, protected:)
    if (/^\s*(?:public|private|protected)\s*:/.test(line)) {
      currentSection = null;
      continue;
    }

    // Extract methods inside signals: / slots: sections
    if (currentSection && currentClass) {
      const declMatch = line.match(RE_FUNC_DECL);
      if (declMatch) {
        const [, , methodName, params] = declMatch;
        if (!methodName) continue;
        const nodeId = generateNodeId(filePath, 'method', `${currentClass}::${methodName}`, lineNum);
        nodes.push({
          id: nodeId,
          kind: 'method',
          name: methodName,
          qualifiedName: `${filePath}::${currentClass}::${methodName}`,
          filePath,
          language: 'cpp' as Language,
          startLine: lineNum,
          endLine: lineNum,
          startColumn: line.search(/\S/),
          endColumn: line.trimEnd().length,
          signature: `${currentSection === 'signals' ? 'signal' : 'slot'} ${methodName}(${params ?? ''})`,
          updatedAt: Date.now(),
        });
      }
    }

    // Extract Q_INVOKABLE methods in the class body (outside signals/slots)
    // These are callable from QML and should be tagged as invokable.
    if (!currentSection && currentClass) {
      const invokableMatch = line.match(RE_Q_INVOKABLE_DECL);
      if (invokableMatch) {
        const methodName = invokableMatch[2]!;
        const params = invokableMatch[3] ?? '';
        const nodeId = generateNodeId(filePath, 'method', `${currentClass}::${methodName}`, lineNum);
        nodes.push({
          id: nodeId,
          kind: 'method',
          name: methodName,
          qualifiedName: `${filePath}::${currentClass}::${methodName}`,
          filePath,
          language: 'cpp' as Language,
          startLine: lineNum,
          endLine: lineNum,
          startColumn: line.search(/\S/),
          endColumn: line.trimEnd().length,
          signature: `invokable ${methodName}(${params})`,
          updatedAt: Date.now(),
        });
      }
    }
  }

  // ---- pass 2: Q_PROPERTY extraction ----
  // Re-scan with regex over the full source (may span lines but usually one line)
  let propMatch: RegExpExecArray | null;
  RE_Q_PROPERTY.lastIndex = 0;
  while ((propMatch = RE_Q_PROPERTY.exec(content)) !== null) {
    const macroBody = propMatch[1]!;
    const prop = parseQProperty(macroBody);
    if (!prop || !prop.name) continue;

    // Determine line number from the match offset
    const lineNum = content.slice(0, propMatch.index).split('\n').length;
    const nodeId = generateNodeId(filePath, 'property', prop.name, lineNum);
    nodes.push({
      id: nodeId,
      kind: 'property',
      name: prop.name,
      qualifiedName: `${filePath}::${prop.name}`,
      filePath,
      language: 'cpp' as Language,
      startLine: lineNum,
      endLine: lineNum,
      startColumn: 0,
      endColumn: 0,
      signature: `Q_PROPERTY(${prop.type} ${prop.name})`,
      updatedAt: Date.now(),
    });

    // Emit references to getter, setter, notify signal
    const propRefs = [
      prop.read && { name: prop.read, kind: 'calls' as const },
      prop.write && { name: prop.write, kind: 'calls' as const },
      prop.notify && { name: prop.notify, kind: 'calls' as const },
    ].filter((r): r is { name: string; kind: 'calls' } => !!r);

    for (const ref of propRefs) {
      references.push({
        fromNodeId: nodeId,
        referenceName: ref.name,
        referenceKind: ref.kind,
        line: lineNum,
        column: 0,
        filePath,
        language: 'cpp' as Language,
      });
    }
  }

  // ---- pass 3: connect() call extraction ----
  RE_CONNECT_MACRO.lastIndex = 0;
  let connectMatch: RegExpExecArray | null;
  while ((connectMatch = RE_CONNECT_MACRO.exec(content)) !== null) {
    const signalName = connectMatch[1]!;
    const slotName = connectMatch[2]!;
    const lineNum = content.slice(0, connectMatch.index).split('\n').length;

    references.push({
      fromNodeId: generateNodeId(filePath, 'file', filePath, 1),
      referenceName: signalName,
      referenceKind: 'calls',
      line: lineNum,
      column: 0,
      filePath,
      language: 'cpp' as Language,
    });
    references.push({
      fromNodeId: generateNodeId(filePath, 'file', filePath, 1),
      referenceName: slotName,
      referenceKind: 'calls',
      line: lineNum,
      column: 0,
      filePath,
      language: 'cpp' as Language,
    });
  }

  RE_CONNECT_PTR.lastIndex = 0;
  while ((connectMatch = RE_CONNECT_PTR.exec(content)) !== null) {
    // &ClassName::signalName
    const signalClass = connectMatch[1]!;
    const signalName = connectMatch[2]!;
    const slotClass = connectMatch[3]!;
    const slotName = connectMatch[4]!;
    const lineNum = content.slice(0, connectMatch.index).split('\n').length;

    references.push(
      {
        fromNodeId: generateNodeId(filePath, 'file', filePath, 1),
        referenceName: signalName,
        referenceKind: 'calls',
        line: lineNum,
        column: 0,
        filePath,
        language: 'cpp' as Language,
        candidates: [`${signalClass}::${signalName}`],
      },
      {
        fromNodeId: generateNodeId(filePath, 'file', filePath, 1),
        referenceName: slotName,
        referenceKind: 'calls',
        line: lineNum,
        column: 0,
        filePath,
        language: 'cpp' as Language,
        candidates: [`${slotClass}::${slotName}`],
      },
    );
  }

  // ---- pass 4: QML_NAMED_ELEMENT extraction ----
  // Creates a `component` alias node so QML `TypeName { }` can resolve to the C++ class.
  RE_QML_NAMED_ELEMENT.lastIndex = 0;
  let qmlNamedMatch: RegExpExecArray | null;
  while ((qmlNamedMatch = RE_QML_NAMED_ELEMENT.exec(content)) !== null) {
    const qmlName = qmlNamedMatch[1]!;
    const lineNum = content.slice(0, qmlNamedMatch.index).split('\n').length;
    const nodeId = generateNodeId(filePath, 'component', qmlName, lineNum);
    nodes.push({
      id: nodeId,
      kind: 'component',
      name: qmlName,
      qualifiedName: `${filePath}::${qmlName}`,
      filePath,
      language: 'cpp' as Language,
      startLine: lineNum,
      endLine: lineNum,
      startColumn: 0,
      endColumn: 0,
      signature: `QML_NAMED_ELEMENT(${qmlName})`,
      updatedAt: Date.now(),
    });
    // Emit a reference from this alias component to the C++ class (determined by
    // the closest preceding class header in the file).
    references.push({
      fromNodeId: nodeId,
      referenceName: qmlName,
      referenceKind: 'references',
      line: lineNum,
      column: 0,
      filePath,
      language: 'cpp' as Language,
    });
  }

  // ---- pass 5: qmlRegisterType<CppClass>(uri, major, minor, "QmlName") ----
  RE_QML_REGISTER_TYPE.lastIndex = 0;
  let qmlRegMatch: RegExpExecArray | null;
  while ((qmlRegMatch = RE_QML_REGISTER_TYPE.exec(content)) !== null) {
    const cppClass = qmlRegMatch[1]!;
    const qmlName = qmlRegMatch[2]!;
    const lineNum = content.slice(0, qmlRegMatch.index).split('\n').length;
    // Only create an alias node when the QML name differs from the C++ class name,
    // since same-name resolution already works via the class node.
    if (qmlName !== cppClass) {
      const nodeId = generateNodeId(filePath, 'component', qmlName, lineNum);
      nodes.push({
        id: nodeId,
        kind: 'component',
        name: qmlName,
        qualifiedName: `${filePath}::${qmlName}`,
        filePath,
        language: 'cpp' as Language,
        startLine: lineNum,
        endLine: lineNum,
        startColumn: 0,
        endColumn: 0,
        signature: `qmlRegisterType<${cppClass}>("${qmlName}")`,
        updatedAt: Date.now(),
      });
    }
    // Always emit a reference from the file to the C++ class being registered
    references.push({
      fromNodeId: generateNodeId(filePath, 'file', filePath, 1),
      referenceName: cppClass,
      referenceKind: 'references',
      line: lineNum,
      column: 0,
      filePath,
      language: 'cpp' as Language,
    });
  }

  return { nodes, references };
}

// ---------------------------------------------------------------------------
// QML signal handler → C++ signal resolution
// ---------------------------------------------------------------------------

/**
 * Converts a QML signal handler name to the underlying signal name.
 * `onFooChanged` → `fooChanged`, `onClicked` → `clicked`
 */
function handlerToSignalName(handlerName: string): string {
  // handlerName is e.g. "onFooChanged" — strip leading "on" and lowercase first letter
  const body = handlerName.slice(2);
  return body[0]!.toLowerCase() + body.slice(1);
}

/**
 * Checks whether a reference name looks like a QML signal handler.
 */
function isQmlSignalHandler(name: string): boolean {
  return /^on[A-Z]/.test(name);
}

// ---------------------------------------------------------------------------
// FrameworkResolver export
// ---------------------------------------------------------------------------

export const qtResolver: FrameworkResolver = {
  name: 'qt',
  languages: ['cpp', 'c', 'qml'],

  detect(context: ResolutionContext): boolean {
    const allFiles = context.getAllFiles();

    // Check for .qml files in the project
    if (allFiles.some((f) => f.endsWith('.qml'))) return true;

    // Check for Qt headers in C++ files
    for (const file of allFiles) {
      if (!file.endsWith('.cpp') && !file.endsWith('.h') && !file.endsWith('.hpp')) continue;
      const content = context.readFile(file);
      if (content && (QT_INCLUDE_PATTERN.test(content) || Q_OBJECT_PATTERN.test(content) || QML_ELEMENT_PATTERN.test(content))) {
        return true;
      }
    }

    // Check CMakeLists.txt for Qt
    const cmake = context.readFile('CMakeLists.txt');
    if (cmake && /find_package\s*\(\s*Qt/i.test(cmake)) return true;

    // Check .pro file (qmake)
    const proFile = allFiles.find((f) => f.endsWith('.pro'));
    if (proFile) {
      const pro = context.readFile(proFile);
      if (pro && /QT\s*[+]?=/.test(pro)) return true;
    }

    return false;
  },

  extract(filePath: string, content: string): FrameworkExtractionResult {
    const ext = path.extname(filePath).toLowerCase();

    if (ext === '.cpp' || ext === '.h' || ext === '.hpp' || ext === '.cxx' || ext === '.cc') {
      return extractQtFromCpp(filePath, content);
    }

    return { nodes: [], references: [] };
  },

  resolve(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null {
    // QML → C++ signal handler resolution
    // A QML `onFooChanged:` binding references the `fooChanged` signal,
    // which may be declared in a C++ QObject class.
    if (ref.language === 'qml' && isQmlSignalHandler(ref.referenceName)) {
      const signalName = handlerToSignalName(ref.referenceName);
      const candidates = context.getNodesByName(signalName).filter(
        (n: Node) => n.kind === 'method' && (n.language === 'cpp' || n.language === 'qml'),
      );
      if (candidates.length === 1) {
        return {
          original: ref,
          targetNodeId: candidates[0]!.id,
          confidence: 0.75,
          resolvedBy: 'framework',
        };
      }
      // Multiple candidates — pick the one in the same directory as the QML file
      if (candidates.length > 1) {
        const qmlDir = path.dirname(ref.filePath);
        const sameDir = candidates.find((n: Node) => path.dirname(n.filePath) === qmlDir);
        const target = sameDir ?? candidates[0]!;
        return {
          original: ref,
          targetNodeId: target.id,
          confidence: 0.65,
          resolvedBy: 'framework',
        };
      }
    }

    // QML import → C++ module (registered via Q_DECLARE_QML_ELEMENT or qmlRegisterType)
    if (ref.language === 'qml' && ref.referenceKind === 'imports') {
      const moduleName = ref.referenceName;
      // A QML module like "VerificationResultsDRC" might match a C++ class or file
      const candidates = context.getNodesByName(moduleName);
      if (candidates.length > 0) {
        return {
          original: ref,
          targetNodeId: candidates[0]!.id,
          confidence: 0.6,
          resolvedBy: 'framework',
        };
      }
    }

    // QML component type → C++ class that registered it
    if (ref.language === 'qml' && ref.referenceKind === 'references') {
      const typeName = ref.referenceName;
      const candidates = context.getNodesByName(typeName).filter(
        (n: Node) => n.kind === 'class' || n.kind === 'component',
      );
      if (candidates.length === 1) {
        return {
          original: ref,
          targetNodeId: candidates[0]!.id,
          confidence: 0.7,
          resolvedBy: 'framework',
        };
      }
    }

    return null;
  },

  claimsReference(name: string): boolean {
    // Claim QML signal handler references even if no node is named that yet
    return isQmlSignalHandler(name);
  },
};
