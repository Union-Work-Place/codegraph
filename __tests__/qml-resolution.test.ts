import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';
import { initGrammars } from '../src/extraction/grammars';

beforeAll(async () => {
    await initGrammars();
});

describe('QML persisted signal resolution', () => {
  let tempDir: string | undefined;

  afterEach(() => {
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  });

  it('resolves handlers by owner and leaves unknown owners unresolved', async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-qml-resolution-'));
    fs.writeFileSync(
      path.join(tempDir, 'AlphaButton.qml'),
      'import QtQuick\nItem {\n    signal clicked()\n}\n',
    );
    fs.writeFileSync(
      path.join(tempDir, 'BetaButton.qml'),
      'import QtQuick\nItem {\n    signal clicked()\n}\n',
    );
    fs.writeFileSync(
        path.join(tempDir, 'AttachedWidget.qml'),
        'import QtQuick\nItem {\n    signal activated()\n}\n',
    );
      fs.writeFileSync(
      path.join(tempDir, 'Main.qml'),
      `import QtQuick
Item {
    signal ready()
    onReady: {}

    AlphaButton {
        onClicked: {}
    }
    BetaButton {
        onClicked: {}
    }
    AttachedWidget.onActivated: {}
    MainBarButton {
        onClicked: {}
    }

    Component.onCompleted: {
        finishStartup()
    }
    function finishStartup() {}
}
`,
    );

    const graph = CodeGraph.initSync(tempDir);
    try {
      const result = await graph.indexAll();
      expect(result.success).toBe(true);
      expect(graph.getDetectedFrameworks()).toContain('qt');

      const alphaSignal = graph.getNodesInFile('AlphaButton.qml').find(
        (node) => node.kind === 'method' && node.name === 'clicked',
      );
      const betaSignal = graph.getNodesInFile('BetaButton.qml').find(
        (node) => node.kind === 'method' && node.name === 'clicked',
      );
        const activatedSignal = graph.getNodesInFile('AttachedWidget.qml').find(
            (node) => node.kind === 'method' && node.name === 'activated',
        );
      const mainNodes = graph.getNodesInFile('Main.qml');
      const readySignal = mainNodes.find((node) => node.kind === 'method' && node.name === 'ready');
      const readyHandler = mainNodes.find((node) => node.kind === 'method' && node.name === 'onReady');
      const finishStartup = mainNodes.find(
        (node) => node.kind === 'function' && node.name === 'finishStartup',
      );
      const completedHandler = mainNodes.find(
        (node) => node.kind === 'method' && node.name === 'Component.onCompleted',
      );
        const attachedHandler = mainNodes.find(
            (node) => node.kind === 'method' && node.name === 'AttachedWidget.onActivated',
        );
      const clickHandlers = mainNodes
        .filter((node) => node.kind === 'method' && node.name === 'onClicked')
        .sort((left, right) => left.startLine - right.startLine);

      expect(alphaSignal).toBeDefined();
      expect(betaSignal).toBeDefined();
        expect(activatedSignal).toBeDefined();
      expect(readySignal).toBeDefined();
      expect(readyHandler).toBeDefined();
      expect(finishStartup).toBeDefined();
      expect(completedHandler).toBeDefined();
        expect(attachedHandler).toBeDefined();
      expect(clickHandlers).toHaveLength(3);

      const callTargets = (nodeId: string) =>
        graph.getOutgoingEdges(nodeId)
          .filter((edge) => edge.kind === 'calls')
          .map((edge) => edge.target);
      const callEdges = (nodeId: string) =>
        graph.getOutgoingEdges(nodeId).filter((edge) => edge.kind === 'calls');
        const referenceTargets = (nodeId: string) =>
            graph.getOutgoingEdges(nodeId)
                .filter((edge) => edge.kind === 'references')
                .map((edge) => edge.target);
        const referenceEdges = (nodeId: string) =>
            graph.getOutgoingEdges(nodeId).filter((edge) => edge.kind === 'references');
        const qualifiedReferenceTargets = (nodeId: string) => {
            const targetIds = new Set(referenceTargets(nodeId));
        return [
          ...graph.getNodesInFile('AlphaButton.qml'),
          ...graph.getNodesInFile('BetaButton.qml'),
          ...mainNodes,
        ]
          .filter((node) => targetIds.has(node.id))
          .map((node) => node.qualifiedName);
      };
        const synthesized = (sourceId: string, targetId: string) =>
            graph.getOutgoingEdges(sourceId).find(
                (edge) =>
                    edge.kind === 'calls' &&
                    edge.target === targetId &&
                    edge.provenance === 'heuristic' &&
                    edge.metadata?.synthesizedBy === 'qt-signal-channel',
            );

        expect(callTargets(readyHandler!.id)).not.toContain(readySignal!.id);
        expect(referenceTargets(readyHandler!.id)).toEqual([readySignal!.id]);
        expect(qualifiedReferenceTargets(clickHandlers[0]!.id)).toEqual(['AlphaButton.qml::clicked']);
        expect(qualifiedReferenceTargets(clickHandlers[1]!.id)).toEqual(['BetaButton.qml::clicked']);
        expect(qualifiedReferenceTargets(clickHandlers[2]!.id)).toEqual([]);
        expect(callTargets(clickHandlers[0]!.id)).not.toContain(alphaSignal!.id);
        expect(callTargets(clickHandlers[1]!.id)).not.toContain(betaSignal!.id);
        expect(referenceEdges(clickHandlers[0]!.id)[0]?.metadata).toMatchObject({ resolvedBy: 'framework' });
        expect(referenceEdges(clickHandlers[1]!.id)[0]?.metadata).toMatchObject({ resolvedBy: 'framework' });
        expect(synthesized(readySignal!.id, readyHandler!.id)).toMatchObject({
            metadata: expect.objectContaining({ registeredAt: 'Main.qml:4' }),
        });
        expect(synthesized(alphaSignal!.id, clickHandlers[0]!.id)).toBeDefined();
        expect(synthesized(betaSignal!.id, clickHandlers[1]!.id)).toBeDefined();
        expect(callTargets(attachedHandler!.id)).not.toContain(activatedSignal!.id);
        expect(referenceTargets(attachedHandler!.id)).toContain(activatedSignal!.id);
        expect(synthesized(activatedSignal!.id, attachedHandler!.id)).toBeDefined();
      expect(callTargets(completedHandler!.id)).toContain(finishStartup!.id);
      expect(graph.getOutgoingEdges(completedHandler!.id)).not.toEqual(
        expect.arrayContaining([expect.objectContaining({ kind: 'references' })]),
      );
    } finally {
      graph.close();
    }
  });

  it('resolves calls through a QML id only to the exact C++ owner', async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-qml-id-resolution-'));
    fs.writeFileSync(
      path.join(tempDir, 'native-panel.h'),
      `#include <QObject>
class NativePanel : public QObject {
    Q_OBJECT
public:
    Q_INVOKABLE void refresh();
};
`,
    );
    fs.writeFileSync(
      path.join(tempDir, 'other-panel.h'),
      `#include <QObject>
class OtherPanel : public QObject {
    Q_OBJECT
public:
    Q_INVOKABLE void refresh();
};
`,
    );
    fs.writeFileSync(
      path.join(tempDir, 'Main.qml'),
      `import Demo.Ui
Item {
    NativePanel {
        id: backend
    }
    function refreshPanel() {
        backend.refresh()
    }
}
`,
    );

    const graph = CodeGraph.initSync(tempDir);
    try {
      const result = await graph.indexAll();
      expect(result.success).toBe(true);

      const caller = graph.getNodesInFile('Main.qml').find(
        (node) => node.kind === 'function' && node.name === 'refreshPanel',
      );
      const nativeMethod = graph.getNodesInFile('native-panel.h').find(
        (node) => node.kind === 'method' && node.name === 'refresh',
      );
      const otherMethod = graph.getNodesInFile('other-panel.h').find(
        (node) => node.kind === 'method' && node.name === 'refresh',
      );

      expect(caller).toBeDefined();
      expect(nativeMethod).toBeDefined();
      expect(otherMethod).toBeDefined();
      const callTargets = graph.getOutgoingEdges(caller!.id)
        .filter((edge) => edge.kind === 'calls')
        .map((edge) => edge.target);
      expect(callTargets).toEqual([nativeMethod!.id]);
      expect(callTargets).not.toContain(otherMethod!.id);
    } finally {
      graph.close();
    }
  });

  it('persists a typed id call from a multi-call attached handler body', async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-qml-handler-id-'));
    fs.writeFileSync(
      path.join(tempDir, 'native-panel.h'),
      `#include <QObject>
class NativePanel : public QObject {
    Q_OBJECT
public:
    Q_INVOKABLE void refresh(const QString& inputPath,
                             bool strictMode);
};
`,
    );
    fs.writeFileSync(
      path.join(tempDir, 'Main.qml'),
      `import QtQuick
Item {
    NativePanel {
        id: backend
    }
    Component.onCompleted: {
        console.log("starting")
        backend.refresh("input", true)
        console.log("done")
    }
}
`,
    );

    const graph = CodeGraph.initSync(tempDir);
    try {
      expect((await graph.indexAll()).success).toBe(true);
      const handler = graph.getNodesInFile('Main.qml').find(
        (node) => node.name === 'Component.onCompleted',
      );
      const target = graph.getNodesInFile('native-panel.h').find(
        (node) => node.name === 'refresh' && node.signature?.startsWith('invokable'),
      );
      expect(handler).toBeDefined();
      expect(target).toBeDefined();
      expect(graph.getOutgoingEdges(handler!.id)).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: 'calls', target: target!.id }),
      ]));
    } finally {
      graph.close();
    }
  });

    it('resolves block-style and inline QML handlers to an invokable C++ method', async () => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-qml-click-handler-'));
        fs.writeFileSync(
            path.join(tempDir, 'native-panel.h'),
            `#include <QObject>
class NativePanel : public QObject {
    Q_OBJECT
public:
    Q_INVOKABLE void refresh();
};
`,
        );
        fs.writeFileSync(
            path.join(tempDir, 'Main.qml'),
            `import QtQuick
Item {
    NativePanel {
        id: backend
    }
    MouseArea {
        onClicked: {
            backend.refresh()
        }
    }
    MouseArea {
      onPressed: backend.refresh()
    }
}
`,
        );

        const graph = CodeGraph.initSync(tempDir);
        try {
            expect((await graph.indexAll()).success).toBe(true);
            const handler = graph.getNodesInFile('Main.qml').find(
                (node) => node.kind === 'method' && node.name === 'onClicked',
            );
            const inlineHandler = graph.getNodesInFile('Main.qml').find(
                (node) => node.kind === 'method' && node.name === 'onPressed',
            );
            const target = graph.getNodesInFile('native-panel.h').find(
                (node) => node.kind === 'method' && node.name === 'refresh',
            );

            expect(handler).toBeDefined();
            expect(inlineHandler).toBeDefined();
            expect(target).toBeDefined();
            expect(graph.getOutgoingEdges(handler!.id)).toEqual(expect.arrayContaining([
                expect.objectContaining({ kind: 'calls', target: target!.id }),
            ]));
            expect(graph.getOutgoingEdges(inlineHandler!.id)).toEqual(expect.arrayContaining([
                expect.objectContaining({ kind: 'calls', target: target!.id }),
            ]));
        } finally {
            graph.close();
        }
    });

  it('resolves calls through a QML id to the exact QML component file', async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-qml-component-id-'));
    fs.writeFileSync(
      path.join(tempDir, 'ChildPanel.qml'),
      'import QtQuick\nItem {\n    function reload() {}\n}\n',
    );
    fs.writeFileSync(
      path.join(tempDir, 'OtherPanel.qml'),
      'import QtQuick\nItem {\n    function reload() {}\n}\n',
    );
    fs.writeFileSync(
      path.join(tempDir, 'Main.qml'),
      `import QtQuick
Item {
  ChildPanel {
    id: child
  }
    function reloadChild() {
        child.reload()
    }
}
`,
    );

    const graph = CodeGraph.initSync(tempDir);
    try {
      expect((await graph.indexAll()).success).toBe(true);
      const caller = graph.getNodesInFile('Main.qml').find((node) => node.name === 'reloadChild');
      const childMethod = graph.getNodesInFile('ChildPanel.qml').find((node) => node.name === 'reload');
      const otherMethod = graph.getNodesInFile('OtherPanel.qml').find((node) => node.name === 'reload');
      const targets = graph.getOutgoingEdges(caller!.id)
        .filter((edge) => edge.kind === 'calls')
        .map((edge) => edge.target);
      expect(targets).toEqual([childMethod!.id]);
      expect(targets).not.toContain(otherMethod!.id);
    } finally {
      graph.close();
    }
  });

  it('resolves a QML id through its registered QML type alias', async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-qml-registered-id-'));
    fs.writeFileSync(
      path.join(tempDir, 'internal-panel.h'),
      `#include <QObject>
class InternalPanel : public QObject {
    Q_OBJECT
public:
    Q_INVOKABLE void refresh();
};
`,
    );
    fs.writeFileSync(
      path.join(tempDir, 'registration.cpp'),
      `#include <QtQml>
#include "internal-panel.h"
void registerTypes() {
    qmlRegisterType<InternalPanel>("Demo.Ui", 1, 0, "FriendlyPanel");
}
`,
    );
    fs.writeFileSync(
      path.join(tempDir, 'Main.qml'),
      `import Demo.Ui
Item {
  FriendlyPanel {
    id: panel
  }
    function updatePanel() {
        panel.refresh()
    }
}
`,
    );

    const graph = CodeGraph.initSync(tempDir);
    try {
      expect((await graph.indexAll()).success).toBe(true);
      const caller = graph.getNodesInFile('Main.qml').find((node) => node.name === 'updatePanel');
      const method = graph.getNodesInFile('internal-panel.h').find((node) => node.name === 'refresh');
      const targets = graph.getOutgoingEdges(caller!.id)
        .filter((edge) => edge.kind === 'calls')
        .map((edge) => edge.target);
      expect(targets).toEqual([method!.id]);
    } finally {
      graph.close();
    }
  });

    it('prefers a same-name registered C++ type over a local QML component', async () => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-qml-same-name-registration-'));
        fs.writeFileSync(
            path.join(tempDir, 'file-analyzer.h'),
            `#include <QObject>
class FileAnalyzer : public QObject {
    Q_OBJECT
public:
    Q_INVOKABLE void refresh();
};
`,
        );
        fs.writeFileSync(
            path.join(tempDir, 'registration.cpp'),
            `#include <QtQml>
void registerTypes() {
    qmlRegisterType<FileAnalyzer>("Demo.Ui", 1, 0, "FileAnalyzer");
}
`,
        );
        fs.writeFileSync(
            path.join(tempDir, 'FileAnalyzer.qml'),
            'import QtQuick\nItem {\n    function refresh() {}\n}\n',
        );
        fs.writeFileSync(
            path.join(tempDir, 'Main.qml'),
            `import Demo.Ui
Item {
    FileAnalyzer {
        id: analyzer
    }
    function update() {
        analyzer.refresh()
    }
}
`,
        );

        const graph = CodeGraph.initSync(tempDir);
        try {
            expect((await graph.indexAll()).success).toBe(true);
            const mainRoot = graph.getNodesInFile('Main.qml').find(
                (node) => node.kind === 'component' && node.name === 'Main',
            );
            const cppClass = graph.getNodesInFile('file-analyzer.h').find(
                (node) => node.kind === 'class' && node.name === 'FileAnalyzer',
            );
            const qmlComponent = graph.getNodesInFile('FileAnalyzer.qml').find(
                (node) => node.kind === 'component' && node.name === 'FileAnalyzer',
            );
            const caller = graph.getNodesInFile('Main.qml').find(
                (node) => node.kind === 'function' && node.name === 'update',
            );
            const cppMethod = graph.getNodesInFile('file-analyzer.h').find(
                (node) => node.kind === 'method' && node.name === 'refresh',
            );
            const qmlMethod = graph.getNodesInFile('FileAnalyzer.qml').find(
                (node) => node.kind === 'function' && node.name === 'refresh',
            );

            expect(mainRoot).toBeDefined();
            expect(cppClass).toBeDefined();
            expect(qmlComponent).toBeDefined();
            expect(caller).toBeDefined();
            expect(cppMethod).toBeDefined();
            expect(qmlMethod).toBeDefined();
            expect(graph.getOutgoingEdges(mainRoot!.id)).toEqual(expect.arrayContaining([
                expect.objectContaining({ kind: 'references', target: cppClass!.id }),
            ]));
            expect(graph.getOutgoingEdges(mainRoot!.id)).not.toEqual(expect.arrayContaining([
                expect.objectContaining({ kind: 'references', target: qmlComponent!.id }),
            ]));
            expect(graph.getOutgoingEdges(caller!.id)).toEqual(expect.arrayContaining([
                expect.objectContaining({ kind: 'calls', target: cppMethod!.id }),
            ]));
            expect(graph.getOutgoingEdges(caller!.id)).not.toEqual(expect.arrayContaining([
                expect.objectContaining({ kind: 'calls', target: qmlMethod!.id }),
            ]));
        } finally {
            graph.close();
        }
    });

  it('resolves a registered QML signal handler through its type alias', async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-qml-signal-alias-'));
    fs.writeFileSync(
      path.join(tempDir, 'internal-panel.h'),
      `#include <QObject>
class InternalPanel : public QObject {
    Q_OBJECT
signals:
    void updated();
};
`,
    );
    fs.writeFileSync(
      path.join(tempDir, 'registration.cpp'),
      `#include <QtQml>
void registerTypes() {
    qmlRegisterType<InternalPanel>("Demo.Ui", 1, 0, "FriendlyPanel");
}
`,
    );
    fs.writeFileSync(
      path.join(tempDir, 'Main.qml'),
      'import Demo.Ui\nItem {\n    FriendlyPanel {\n        onUpdated: {}\n    }\n}\n',
    );
    const graph = CodeGraph.initSync(tempDir);
    try {
      expect((await graph.indexAll()).success).toBe(true);
      const handler = graph.getNodesInFile('Main.qml').find((node) => node.name === 'onUpdated');
      const signal = graph.getNodesInFile('internal-panel.h').find((node) => node.name === 'updated');
      expect(graph.getOutgoingEdges(handler!.id)).toEqual(expect.arrayContaining([
          expect.objectContaining({ kind: 'references', target: signal!.id }),
      ]));
        expect(graph.getOutgoingEdges(handler!.id)).not.toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: 'calls', target: signal!.id }),
      ]));
          expect(graph.getOutgoingEdges(signal!.id)).toEqual(expect.arrayContaining([
              expect.objectContaining({
                  kind: 'calls',
                  target: handler!.id,
                  provenance: 'heuristic',
                  metadata: expect.objectContaining({
                      synthesizedBy: 'qt-signal-channel',
                      registeredAt: 'Main.qml:4',
                  }),
              }),
          ]));
      } finally {
          graph.close();
      }
  });

    it('resolves a Connections handler only to its literal target type and extracts its body once', async () => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-qml-connections-target-'));
        fs.writeFileSync(
            path.join(tempDir, 'native-panel.h'),
            `#include <QObject>
class NativePanel : public QObject {
    Q_OBJECT
signals:
    void updated();
public:
    Q_INVOKABLE void refresh();
};
`,
        );
        fs.writeFileSync(
            path.join(tempDir, 'other-panel.h'),
            `#include <QObject>
class OtherPanel : public QObject {
    Q_OBJECT
signals:
    void updated();
};
`,
        );
        fs.writeFileSync(
            path.join(tempDir, 'Main.qml'),
            `import QtQuick
Item {
    NativePanel {
        id: backend
    }
    Connections {
        target: backend
        function onUpdated() {
            backend.refresh()
        }
    }
}
`,
        );

        const graph = CodeGraph.initSync(tempDir);
        try {
            expect((await graph.indexAll()).success).toBe(true);
            const mainNodes = graph.getNodesInFile('Main.qml');
            const connections = mainNodes.find((node) => node.kind === 'component' && node.name === 'Connections');
            const handler = mainNodes.find((node) => node.kind === 'method' && node.name === 'onUpdated');
            const nativeSignal = graph.getNodesInFile('native-panel.h').find((node) => node.name === 'updated');
            const otherSignal = graph.getNodesInFile('other-panel.h').find((node) => node.name === 'updated');
            const refresh = graph.getNodesInFile('native-panel.h').find((node) => node.name === 'refresh');

            expect(connections).toBeDefined();
            expect(handler).toMatchObject({ signature: 'handler onUpdated' });
            expect(nativeSignal).toBeDefined();
            expect(otherSignal).toBeDefined();
            expect(refresh).toBeDefined();
            expect(graph.getOutgoingEdges(connections!.id)).toEqual(expect.arrayContaining([
                expect.objectContaining({ kind: 'contains', target: handler!.id }),
            ]));

            const calls = graph.getOutgoingEdges(handler!.id).filter((edge) => edge.kind === 'calls');
            expect(calls).toEqual(expect.arrayContaining([
                expect.objectContaining({ target: refresh!.id }),
            ]));
            expect(calls).not.toEqual(expect.arrayContaining([
                expect.objectContaining({ target: nativeSignal!.id }),
                expect.objectContaining({ target: otherSignal!.id }),
            ]));
            expect(graph.getOutgoingEdges(handler!.id)).toEqual(expect.arrayContaining([
                expect.objectContaining({ kind: 'references', target: nativeSignal!.id }),
            ]));
            expect(graph.getOutgoingEdges(handler!.id)).not.toEqual(expect.arrayContaining([
                expect.objectContaining({ kind: 'references', target: otherSignal!.id }),
            ]));
            expect(graph.getOutgoingEdges(nativeSignal!.id)).toEqual(expect.arrayContaining([
                expect.objectContaining({
                    kind: 'calls',
                    target: handler!.id,
                    provenance: 'heuristic',
                    metadata: expect.objectContaining({
                        synthesizedBy: 'qt-signal-channel',
                        registeredAt: 'Main.qml:8',
                    }),
                }),
            ]));
            expect(calls.filter((edge) => edge.target === refresh!.id)).toHaveLength(1);
        } finally {
            graph.close();
        }
    });

    it('does not guess a Connections signal owner for a dynamic target expression', async () => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-qml-connections-dynamic-target-'));
        fs.writeFileSync(
            path.join(tempDir, 'native-panel.h'),
            '#include <QObject>\nclass NativePanel : public QObject {\n    Q_OBJECT\nsignals:\n    void updated();\n};\n',
        );
        fs.writeFileSync(
            path.join(tempDir, 'other-panel.h'),
            '#include <QObject>\nclass OtherPanel : public QObject {\n    Q_OBJECT\nsignals:\n    void updated();\n};\n',
        );
        fs.writeFileSync(
            path.join(tempDir, 'Main.qml'),
            `import QtQuick
Item {
    NativePanel { id: backend }
    Connections {
        target: selectTarget()
        function onUpdated() {}
    }
    function selectTarget() { return backend }
}
`,
        );

        const graph = CodeGraph.initSync(tempDir);
        try {
            expect((await graph.indexAll()).success).toBe(true);
            const handler = graph.getNodesInFile('Main.qml').find(
                (node) => node.kind === 'method' && node.name === 'onUpdated',
            );
            const signalIds = new Set(
                [...graph.getNodesInFile('native-panel.h'), ...graph.getNodesInFile('other-panel.h')]
                    .filter((node) => node.kind === 'method' && node.name === 'updated')
                    .map((node) => node.id),
            );

            expect(handler).toBeDefined();
            expect(graph.getOutgoingEdges(handler!.id)).not.toEqual(expect.arrayContaining([
                expect.objectContaining({ kind: 'calls', target: expect.any(String) }),
            ]));
            expect(graph.getOutgoingEdges(handler!.id).some(
                (edge) => edge.kind === 'calls' && signalIds.has(edge.target),
            )).toBe(false);
            expect(graph.getOutgoingEdges(handler!.id).some(
                (edge) => edge.kind === 'references' && signalIds.has(edge.target),
            )).toBe(false);
    } finally {
      graph.close();
    }
  });

  it('resolves a QML singleton alias call to its registered C++ type', async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-qml-singleton-alias-'));
    fs.writeFileSync(
      path.join(tempDir, 'app-registry.h'),
      '#include <QObject>\nclass AppRegistry : public QObject {\n Q_OBJECT\npublic:\n Q_INVOKABLE void refresh();\n};\n',
    );
    fs.writeFileSync(
      path.join(tempDir, 'registration.cpp'),
      '#include <QtQml>\nvoid registerTypes() { qmlRegisterSingletonType<AppRegistry>("Demo.Ui", 1, 0, "Registry"); }\n',
    );
    fs.writeFileSync(
      path.join(tempDir, 'Main.qml'),
      'import Demo.Ui\nItem {\n function update() { Registry.refresh() }\n}\n',
    );
    const graph = CodeGraph.initSync(tempDir);
    try {
      expect((await graph.indexAll()).success).toBe(true);
      const caller = graph.getNodesInFile('Main.qml').find((node) => node.name === 'update');
      const target = graph.getNodesInFile('app-registry.h').find((node) => node.name === 'refresh');
      expect(graph.getOutgoingEdges(caller!.id)).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: 'calls', target: target!.id }),
      ]));
    } finally {
      graph.close();
    }
  });

  it('resolves a qualified enum member to its exact owner', async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-qml-enum-owner-'));
    fs.writeFileSync(
      path.join(tempDir, 'qt-enums.cpp'),
      `#include <QObject>
namespace Qt {
enum class Orientation {
  Horizontal,
  Vertical,
};
}
namespace Other {
enum class Orientation {
  Vertical,
};
}
`,
    );
    fs.writeFileSync(
      path.join(tempDir, 'Main.qml'),
      'import QtQuick\nItem {\n    property int orientation: Qt.Vertical\n}\n',
    );
    const graph = CodeGraph.initSync(tempDir);
    try {
      expect((await graph.indexAll()).success).toBe(true);
      const source = graph.getNodesInFile('Main.qml').find((node) => node.name === 'orientation');
      const target = graph.getNodesInFile('qt-enums.cpp').find(
        (node) => node.name === 'Vertical' && node.qualifiedName.startsWith('Qt::'),
      );
      expect(target).toBeDefined();
      expect(graph.getOutgoingEdges(source!.id)).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: 'references', target: target!.id }),
      ]));
    } finally {
      graph.close();
    }
  });

  it('resolves a context property call only to its registered C++ type', async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-qml-context-resolution-'));
    fs.writeFileSync(
      path.join(tempDir, 'report-bridge.h'),
      `#include <QObject>
class ReportBridge : public QObject {
    Q_OBJECT
public:
    Q_INVOKABLE void refresh();
};
`,
    );
    fs.writeFileSync(
      path.join(tempDir, 'other-bridge.h'),
      `#include <QObject>
class OtherBridge : public QObject {
    Q_OBJECT
public:
    Q_INVOKABLE void refresh();
};
`,
    );
    fs.writeFileSync(
      path.join(tempDir, 'bootstrap.cpp'),
      `#include <QQmlContext>
#include "report-bridge.h"
void expose(QQmlContext *context, ReportBridge *service) {
    context->setContextProperty("reportService", service);
}
`,
    );
    fs.writeFileSync(
      path.join(tempDir, 'Main.qml'),
      `import QtQuick
Item {
    function updateReport() {
        reportService.refresh()
    }
}
`,
    );

    const graph = CodeGraph.initSync(tempDir);
    try {
      const result = await graph.indexAll();
      expect(result.success).toBe(true);

      const caller = graph.getNodesInFile('Main.qml').find(
        (node) => node.kind === 'function' && node.name === 'updateReport',
      );
      const reportMethod = graph.getNodesInFile('report-bridge.h').find(
        (node) => node.kind === 'method' && node.name === 'refresh',
      );
      const otherMethod = graph.getNodesInFile('other-bridge.h').find(
        (node) => node.kind === 'method' && node.name === 'refresh',
      );

      expect(caller).toBeDefined();
      expect(reportMethod).toBeDefined();
      expect(otherMethod).toBeDefined();
      const callTargets = graph.getOutgoingEdges(caller!.id)
        .filter((edge) => edge.kind === 'calls')
        .map((edge) => edge.target);
      expect(callTargets).toEqual([reportMethod!.id]);
      expect(callTargets).not.toContain(otherMethod!.id);
    } finally {
      graph.close();
    }
  });

    it('reindexes a modified QML file during sync', async () => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-qml-sync-'));
        const filePath = path.join(tempDir, 'Main.qml');
        fs.writeFileSync(filePath, 'import QtQuick\nItem {\n    function original() {}\n}\n');

        const graph = CodeGraph.initSync(tempDir);
        try {
            expect((await graph.indexAll()).success).toBe(true);
            expect(graph.searchNodes('original')).toHaveLength(1);

            fs.writeFileSync(filePath, 'import QtQuick\nItem {\n    function updated() {}\n}\n');

            const result = await graph.sync();
            expect(result.filesModified).toBe(1);
            expect(graph.searchNodes('original')).toHaveLength(0);
            expect(graph.searchNodes('updated')).toHaveLength(1);
        } finally {
            graph.close();
        }
    });
});