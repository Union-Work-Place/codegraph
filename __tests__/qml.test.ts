/**
 * QML Extractor Tests
 *
 * Tests for the QmlExtractor (QML declarative UI files) and
 * the Qt framework resolver (C++ signal/slot extraction).
 */

import { describe, it, expect } from 'vitest';
import { QmlExtractor } from '../src/extraction/qml-extractor';
import { qtResolver } from '../src/resolution/frameworks/qt';
import { detectLanguage, isSourceFile } from '../src/extraction/grammars';
import { blankQtMacros } from '../src/extraction/languages/c-cpp';

// ---------------------------------------------------------------------------
// Language detection
// ---------------------------------------------------------------------------

describe('QML language detection', () => {
  it('detects .qml as qml', () => {
    expect(detectLanguage('ui/Main.qml')).toBe('qml');
    expect(detectLanguage('components/Button.qml')).toBe('qml');
  });

  it('treats .qml as a source file', () => {
    expect(isSourceFile('ui/Main.qml')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// QML Extractor
// ---------------------------------------------------------------------------

describe('QmlExtractor — imports', () => {
  it('extracts a plain module import', () => {
    const src = `
import QtQuick
Item {}
`.trim();
    const result = new QmlExtractor('ui/Main.qml', src).extract();
    const imp = result.nodes.find((n) => n.kind === 'import');
    expect(imp).toBeDefined();
    expect(imp!.name).toBe('QtQuick');
    expect(imp!.language).toBe('qml');
  });

  it('extracts a versioned import', () => {
    const src = `
import QtQuick 2.15
Item {}
`.trim();
    const result = new QmlExtractor('ui/Main.qml', src).extract();
    const imp = result.nodes.find((n) => n.kind === 'import');
    expect(imp).toBeDefined();
    expect(imp!.name).toBe('QtQuick');
  });

  it('extracts a qualified module import', () => {
    const src = `
import Qt.labs.platform
Item {}
`.trim();
    const result = new QmlExtractor('ui/Main.qml', src).extract();
    const imp = result.nodes.find((n) => n.kind === 'import');
    expect(imp!.name).toBe('Qt.labs.platform');
  });

  it('extracts a directory import with quotes', () => {
    const src = `
import "components"
Item {}
`.trim();
    const result = new QmlExtractor('ui/Main.qml', src).extract();
    const imp = result.nodes.find((n) => n.kind === 'import');
    expect(imp!.name).toBe('components');
  });

  it('extracts multiple imports', () => {
    const src = `
import QtQuick 2.15
import QtQuick.Controls 2.15
import "components"
Item {}
`.trim();
    const result = new QmlExtractor('ui/Main.qml', src).extract();
    const imports = result.nodes.filter((n) => n.kind === 'import');
    expect(imports).toHaveLength(3);
    expect(imports.map((i) => i.name)).toContain('QtQuick');
    expect(imports.map((i) => i.name)).toContain('QtQuick.Controls');
    expect(imports.map((i) => i.name)).toContain('components');
  });
});

describe('QmlExtractor — root component', () => {
  it('creates a component node named after the .qml file', () => {
    const src = `
import QtQuick
Rectangle {
  width: 200
  height: 100
}
`.trim();
    const result = new QmlExtractor('ui/MyButton.qml', src).extract();
    const comp = result.nodes.find((n) => n.kind === 'component');
    expect(comp).toBeDefined();
    expect(comp!.name).toBe('MyButton');
    expect(comp!.language).toBe('qml');
    expect(comp!.isExported).toBe(true);
  });

  it('marks the root component as exported', () => {
    const src = `import QtQuick\nItem {}`;
    const result = new QmlExtractor('views/LoginView.qml', src).extract();
    const comp = result.nodes.find((n) => n.kind === 'component');
    expect(comp!.isExported).toBe(true);
    expect(comp!.name).toBe('LoginView');
  });
});

describe('QmlExtractor — property declarations', () => {
  it('extracts a simple property', () => {
    const src = `
import QtQuick
Item {
    property int count: 0
}
`.trim();
    const result = new QmlExtractor('ui/Counter.qml', src).extract();
    const prop = result.nodes.find((n) => n.kind === 'property' && n.name === 'count');
    expect(prop).toBeDefined();
    expect(prop!.signature).toContain('property int count');
  });

  it('extracts a readonly property', () => {
    const src = `
import QtQuick
Item {
    readonly property string title: "Hello"
}
`.trim();
    const result = new QmlExtractor('ui/Widget.qml', src).extract();
    const prop = result.nodes.find((n) => n.kind === 'property' && n.name === 'title');
    expect(prop).toBeDefined();
  });

  it('extracts a required property', () => {
    const src = `
import QtQuick
Item {
    required property var model
}
`.trim();
    const result = new QmlExtractor('ui/Widget.qml', src).extract();
    const prop = result.nodes.find((n) => n.kind === 'property' && n.name === 'model');
    expect(prop).toBeDefined();
  });
});

describe('QmlExtractor — signal declarations', () => {
  it('extracts a no-arg signal', () => {
    const src = `
import QtQuick
Item {
    signal clicked()
}
`.trim();
    const result = new QmlExtractor('ui/Button.qml', src).extract();
    const sig = result.nodes.find((n) => n.kind === 'method' && n.name === 'clicked');
    expect(sig).toBeDefined();
    expect(sig!.signature).toContain('signal clicked');
  });

  it('extracts a parametrized signal', () => {
    const src = `
import QtQuick
Item {
    signal valueChanged(real newValue)
}
`.trim();
    const result = new QmlExtractor('ui/Slider.qml', src).extract();
    const sig = result.nodes.find((n) => n.kind === 'method' && n.name === 'valueChanged');
    expect(sig).toBeDefined();
  });

  it('extracts multiple signals', () => {
    const src = `
import QtQuick
Item {
    signal pressed()
    signal released()
    signal clicked()
}
`.trim();
    const result = new QmlExtractor('ui/Button.qml', src).extract();
    const sigs = result.nodes.filter((n) => n.kind === 'method');
    expect(sigs.length).toBeGreaterThanOrEqual(3);
  });
});

describe('QmlExtractor — signal handler bindings', () => {
  it('extracts an onClicked handler', () => {
    const src = `
import QtQuick
Item {
    MouseArea {
        onClicked: console.log("clicked")
    }
}
`.trim();
    const result = new QmlExtractor('ui/Main.qml', src).extract();
    const handler = result.nodes.find((n) => n.kind === 'method' && n.name === 'onClicked');
    expect(handler).toBeDefined();
  });

  it('emits an unresolved reference from handler to signal name', () => {
    const src = `
import QtQuick
Item {
    onFooChanged: doSomething()
}
`.trim();
    const result = new QmlExtractor('ui/Main.qml', src).extract();
    const ref = result.unresolvedReferences.find((r) => r.referenceName === 'fooChanged');
    expect(ref).toBeDefined();
    expect(ref!.referenceKind).toBe('calls');
  });
});

describe('QmlExtractor — function declarations', () => {
  it('extracts a function node', () => {
    const src = `
import QtQuick
Item {
    function greet(name) {
        return "Hello " + name
    }
}
`.trim();
    const result = new QmlExtractor('ui/Greeter.qml', src).extract();
    const fn = result.nodes.find((n) => n.kind === 'function' && n.name === 'greet');
    expect(fn).toBeDefined();
    expect(fn!.signature).toContain('function greet');
  });
});

describe('QmlExtractor — nested components', () => {
  it('extracts nested component instantiation', () => {
    const src = `
import QtQuick
Item {
    MyCustomWidget {
        id: widget
    }
}
`.trim();
    const result = new QmlExtractor('ui/Main.qml', src).extract();
    const comps = result.nodes.filter((n) => n.kind === 'component');
    // root + nested
    expect(comps.length).toBeGreaterThanOrEqual(2);
    expect(comps.some((c) => c.name === 'MyCustomWidget')).toBe(true);
  });

  it('emits a contains edge between parent and nested component', () => {
    const src = `
import QtQuick
Item {
    MyWidget {}
}
`.trim();
    const result = new QmlExtractor('ui/Root.qml', src).extract();
    const containsEdges = result.edges.filter((e) => e.kind === 'contains');
    expect(containsEdges.length).toBeGreaterThan(0);
  });

  it('emits an unresolved ref for user-defined nested types', () => {
    const src = `
import QtQuick
Item {
    MyBusinessWidget {}
}
`.trim();
    const result = new QmlExtractor('ui/Root.qml', src).extract();
    const typeRef = result.unresolvedReferences.find(
      (r) => r.referenceName === 'MyBusinessWidget',
    );
    expect(typeRef).toBeDefined();
  });
});

describe('QmlExtractor — error resilience', () => {
  it('does not throw on empty source', () => {
    const result = new QmlExtractor('ui/Empty.qml', '').extract();
    expect(result.errors).toHaveLength(0);
  });

  it('does not throw on malformed QML', () => {
    const src = 'import QtQuick\nItem { unclosed {';
    expect(() => new QmlExtractor('ui/Bad.qml', src).extract()).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Qt framework resolver — C++ extraction
// ---------------------------------------------------------------------------

describe('qtResolver — detection', () => {
  it('detects project with .qml files', () => {
    const ctx = {
      getAllFiles: () => ['src/main.cpp', 'ui/Main.qml'],
      readFile: () => null,
      getNodesByName: () => [],
      getNodesByQualifiedName: () => [],
      getNodesByKind: () => [],
      getNodesByLowerName: () => [],
      fileExists: () => false,
      getProjectRoot: () => '/tmp',
      getImportMappings: () => [],
    };
    // @ts-expect-error — minimal mock
    expect(qtResolver.detect(ctx)).toBe(true);
  });

  it('detects project with QObject includes', () => {
    const ctx = {
      getAllFiles: () => ['src/widget.h'],
      readFile: (f: string) => (f === 'src/widget.h' ? '#include <QObject>\nclass Foo {};' : null),
      getNodesByName: () => [],
      getNodesByQualifiedName: () => [],
      getNodesByKind: () => [],
      getNodesByLowerName: () => [],
      fileExists: () => false,
      getProjectRoot: () => '/tmp',
      getImportMappings: () => [],
    };
    // @ts-expect-error — minimal mock
    expect(qtResolver.detect(ctx)).toBe(true);
  });
});

describe('qtResolver — C++ signal extraction', () => {
  const QT_CPP = `
#include <QObject>

class Counter : public QObject {
    Q_OBJECT
public:
    explicit Counter(QObject *parent = nullptr);
    int value() const;
signals:
    void valueChanged(int newValue);
    void thresholdReached();
public slots:
    void setValue(int value);
    void reset();
};
`.trim();

  it('extracts signal methods from signals: section', () => {
    const { nodes } = qtResolver.extract!('src/counter.h', QT_CPP);
    const signals = nodes.filter((n) => n.signature?.includes('signal'));
    expect(signals.length).toBeGreaterThanOrEqual(2);
    expect(signals.some((n) => n.name === 'valueChanged')).toBe(true);
    expect(signals.some((n) => n.name === 'thresholdReached')).toBe(true);
  });

  it('extracts slot methods from slots: section', () => {
    const { nodes } = qtResolver.extract!('src/counter.h', QT_CPP);
    const slots = nodes.filter((n) => n.signature?.includes('slot'));
    expect(slots.length).toBeGreaterThanOrEqual(2);
    expect(slots.some((n) => n.name === 'setValue')).toBe(true);
    expect(slots.some((n) => n.name === 'reset')).toBe(true);
  });

  it('returns no nodes for non-Qt C++ files', () => {
    const src = `
#include <iostream>
class Foo { void bar() {} };
`.trim();
    const { nodes } = qtResolver.extract!('src/foo.cpp', src);
    expect(nodes).toHaveLength(0);
  });
});

describe('qtResolver — Q_PROPERTY extraction', () => {
  const QT_CPP = `
#include <QObject>
class Widget : public QObject {
    Q_OBJECT
    Q_PROPERTY(int count READ count WRITE setCount NOTIFY countChanged)
    Q_PROPERTY(QString title READ title NOTIFY titleChanged)
};
`.trim();

  it('extracts Q_PROPERTY as property nodes', () => {
    const { nodes } = qtResolver.extract!('src/widget.h', QT_CPP);
    const props = nodes.filter((n) => n.kind === 'property');
    expect(props.length).toBeGreaterThanOrEqual(2);
    expect(props.some((n) => n.name === 'count')).toBe(true);
    expect(props.some((n) => n.name === 'title')).toBe(true);
  });

  it('emits references to READ, WRITE, NOTIFY from Q_PROPERTY', () => {
    const { references } = qtResolver.extract!('src/widget.h', QT_CPP);
    const refNames = references.map((r) => r.referenceName);
    expect(refNames).toContain('count');
    expect(refNames).toContain('setCount');
    expect(refNames).toContain('countChanged');
  });
});

describe('qtResolver — connect() edge extraction', () => {
  const SRC_MACRO = `
#include <QObject>
void setup(Counter *c, Display *d) {
    QObject::connect(c, SIGNAL(valueChanged(int)), d, SLOT(displayValue(int)));
}
`.trim();

  it('extracts SIGNAL/SLOT connect() references', () => {
    const { references } = qtResolver.extract!('src/setup.cpp', SRC_MACRO);
    const refNames = references.map((r) => r.referenceName);
    expect(refNames).toContain('valueChanged');
    expect(refNames).toContain('displayValue');
  });

  const SRC_PTR = `
#include <QObject>
void setup(Counter *c, Display *d) {
    connect(c, &Counter::valueChanged, d, &Display::displayValue);
}
`.trim();

  it('extracts pointer-style connect() references', () => {
    const { references } = qtResolver.extract!('src/setup.cpp', SRC_PTR);
    const refNames = references.map((r) => r.referenceName);
    expect(refNames).toContain('valueChanged');
    expect(refNames).toContain('displayValue');
  });
});

describe('qtResolver — QML signal handler resolution', () => {
  it('resolves onFooChanged to fooChanged signal in C++', () => {
    const signalNode = {
      id: 'sig-1',
      kind: 'method' as const,
      name: 'fooChanged',
      qualifiedName: 'src/widget.h::Widget::fooChanged',
      filePath: 'src/widget.h',
      language: 'cpp' as const,
      startLine: 10,
      endLine: 10,
      startColumn: 0,
      endColumn: 40,
      updatedAt: Date.now(),
      signature: 'signal fooChanged()',
    };

    const ctx = {
      getAllFiles: () => ['ui/Main.qml', 'src/widget.h'],
      readFile: () => null,
      getNodesByName: (name: string) => (name === 'fooChanged' ? [signalNode] : []),
      getNodesByQualifiedName: () => [],
      getNodesByKind: () => [],
      getNodesByLowerName: () => [],
      fileExists: () => false,
      getProjectRoot: () => '/tmp',
      getImportMappings: () => [],
    };

    const ref = {
      fromNodeId: 'handler-1',
      referenceName: 'onFooChanged',
      referenceKind: 'calls' as const,
      line: 5,
      column: 4,
      filePath: 'ui/Main.qml',
      language: 'qml' as const,
    };

    // @ts-expect-error — minimal mock
    const resolved = qtResolver.resolve(ref, ctx);
    expect(resolved).not.toBeNull();
    expect(resolved!.targetNodeId).toBe('sig-1');
    expect(resolved!.resolvedBy).toBe('framework');
  });

  it('does not resolve non-handler QML references', () => {
    const ctx = {
      getAllFiles: () => [],
      readFile: () => null,
      getNodesByName: () => [],
      getNodesByQualifiedName: () => [],
      getNodesByKind: () => [],
      getNodesByLowerName: () => [],
      fileExists: () => false,
      getProjectRoot: () => '/tmp',
      getImportMappings: () => [],
    };

    const ref = {
      fromNodeId: 'node-1',
      referenceName: 'someFunction',
      referenceKind: 'calls' as const,
      line: 3,
      column: 0,
      filePath: 'ui/Main.qml',
      language: 'qml' as const,
    };

    // @ts-expect-error — minimal mock
    const resolved = qtResolver.resolve(ref, ctx);
    expect(resolved).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Qt C++ preParse — blankQtMacros
// ---------------------------------------------------------------------------

describe('blankQtMacros', () => {
  it('blanks Q_OBJECT to same-length spaces', () => {
    const src = 'class Foo : public QObject {\n    Q_OBJECT\npublic:\n};\n';
    const result = blankQtMacros(src);
    expect(result).not.toContain('Q_OBJECT');
    // Byte offset preserved: Q_OBJECT is 8 chars → 8 spaces
    expect(result.indexOf('        \n')).toBeGreaterThan(0);
    expect(result.length).toBe(src.length);
  });

  it('blanks Q_INVOKABLE', () => {
    const src = '    Q_INVOKABLE void doThing();\n';
    const result = blankQtMacros(src);
    expect(result).not.toContain('Q_INVOKABLE');
    expect(result.length).toBe(src.length);
  });

  it('blanks signals: keyword but keeps colon', () => {
    const src = 'signals:\n    void clicked();\n';
    const result = blankQtMacros(src);
    expect(result).not.toContain('signals');
    expect(result).toContain(':');
    expect(result.length).toBe(src.length);
  });

  it('blanks Q_SIGNALS: keyword but keeps colon', () => {
    const src = 'Q_SIGNALS:\n    void pressed();\n';
    const result = blankQtMacros(src);
    expect(result).not.toContain('Q_SIGNALS');
    expect(result).toContain(':');
    expect(result.length).toBe(src.length);
  });

  it('passes through non-Qt source unchanged', () => {
    const src = '#include <iostream>\nint main() { return 0; }\n';
    const result = blankQtMacros(src);
    expect(result).toBe(src);
  });
});
