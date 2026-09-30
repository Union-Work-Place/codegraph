import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';
import { initGrammars, loadAllGrammars } from '../src/extraction/grammars';

beforeAll(async () => {
  await initGrammars();
  await loadAllGrammars();
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
      const mainNodes = graph.getNodesInFile('Main.qml');
      const readySignal = mainNodes.find((node) => node.kind === 'method' && node.name === 'ready');
      const readyHandler = mainNodes.find((node) => node.kind === 'method' && node.name === 'onReady');
      const finishStartup = mainNodes.find(
        (node) => node.kind === 'function' && node.name === 'finishStartup',
      );
      const completedHandler = mainNodes.find(
        (node) => node.kind === 'method' && node.name === 'Component.onCompleted',
      );
      const clickHandlers = mainNodes
        .filter((node) => node.kind === 'method' && node.name === 'onClicked')
        .sort((left, right) => left.startLine - right.startLine);

      expect(alphaSignal).toBeDefined();
      expect(betaSignal).toBeDefined();
      expect(readySignal).toBeDefined();
      expect(readyHandler).toBeDefined();
      expect(finishStartup).toBeDefined();
      expect(completedHandler).toBeDefined();
      expect(clickHandlers).toHaveLength(3);

      const callTargets = (nodeId: string) =>
        graph.getOutgoingEdges(nodeId)
          .filter((edge) => edge.kind === 'calls')
          .map((edge) => edge.target);
      const callEdges = (nodeId: string) =>
        graph.getOutgoingEdges(nodeId).filter((edge) => edge.kind === 'calls');
      const qualifiedTargets = (nodeId: string) => {
        const targetIds = new Set(callTargets(nodeId));
        return [
          ...graph.getNodesInFile('AlphaButton.qml'),
          ...graph.getNodesInFile('BetaButton.qml'),
          ...mainNodes,
        ]
          .filter((node) => targetIds.has(node.id))
          .map((node) => node.qualifiedName);
      };

      expect(callTargets(readyHandler!.id)).toEqual([readySignal!.id]);
      expect(qualifiedTargets(clickHandlers[0]!.id)).toEqual(['AlphaButton.qml::clicked']);
      expect(qualifiedTargets(clickHandlers[1]!.id)).toEqual(['BetaButton.qml::clicked']);
      expect(qualifiedTargets(clickHandlers[2]!.id)).toEqual([]);
      expect(callEdges(clickHandlers[0]!.id)[0]?.metadata).toMatchObject({ resolvedBy: 'framework' });
      expect(callEdges(clickHandlers[1]!.id)[0]?.metadata).toMatchObject({ resolvedBy: 'framework' });
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
        expect.objectContaining({ kind: 'calls', target: signal!.id }),
      ]));
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
});