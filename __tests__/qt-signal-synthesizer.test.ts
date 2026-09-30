import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CodeGraph } from '../src';
import { initGrammars } from '../src/extraction/grammars';

beforeAll(async () => {
  await initGrammars();
});

describe('Qt signal channel synthesizer', () => {
  let dir: string;

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const write = (filePath: string, content: string) => {
    fs.writeFileSync(path.join(dir, filePath), content);
  };

  it('links emit through its signal to a resolved QML handler and both connect syntaxes to slots', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-qt-signal-'));
    write('sender.h', `#include <QObject>
class Sender : public QObject {
    Q_OBJECT
signals:
    void changed();
public:
    void publish();
};
class PointerSender : public QObject {
    Q_OBJECT
signals:
    void refreshed();
};
`);
    write('receiver.h', `#include <QObject>
class Receiver : public QObject {
    Q_OBJECT
public slots:
    void apply();
};
class PointerReceiver : public QObject {
    Q_OBJECT
public slots:
    void update();
};
`);
    write('sender.cpp', `#include "sender.h"
void Sender::publish() {
    emit changed();
}
`);
    write('connections.cpp', `#include "sender.h"
#include "receiver.h"
void wireMacro(Sender *sender, Receiver *receiver) {
    QObject::connect(sender, SIGNAL(changed()), receiver, SLOT(apply()));
}
void wirePointer(PointerSender *sender, PointerReceiver *receiver) {
    QObject::connect(sender, &PointerSender::refreshed, receiver, &PointerReceiver::update);
}
`);
    write('Main.qml', `import QtQuick
Item {
    Sender {
        onChanged: {}
    }
}
`);

    const graph = CodeGraph.initSync(dir);
    try {
      expect((await graph.indexAll()).success).toBe(true);

      const publish = graph.getNodesInFile('sender.cpp').find((node) => node.name === 'publish');
      const senderNodes = graph.getNodesInFile('sender.h');
      const receiverNodes = graph.getNodesInFile('receiver.h');
      const changed = senderNodes.find((node) => node.name === 'changed');
      const refreshed = senderNodes.find((node) => node.name === 'refreshed');
      const apply = receiverNodes.find((node) => node.name === 'apply');
      const update = receiverNodes.find((node) => node.name === 'update');
      const onChanged = graph.getNodesInFile('Main.qml').find((node) => node.name === 'onChanged');

      expect(publish).toBeDefined();
      expect(changed).toBeDefined();
      expect(refreshed).toBeDefined();
      expect(apply).toBeDefined();
      expect(update).toBeDefined();
      expect(onChanged).toBeDefined();

      const synthesized = (sourceId: string, targetId: string) =>
        graph.getOutgoingEdges(sourceId).find(
          (edge) =>
            edge.kind === 'calls' &&
            edge.target === targetId &&
            edge.provenance === 'heuristic' &&
            edge.metadata?.synthesizedBy === 'qt-signal-channel',
        );

      expect(synthesized(publish!.id, changed!.id)).toMatchObject({
        metadata: expect.objectContaining({ registeredAt: 'sender.h:5' }),
      });
      expect(graph.getOutgoingEdges(onChanged!.id)).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: 'references', target: changed!.id }),
      ]));
      expect(graph.getOutgoingEdges(onChanged!.id)).not.toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: 'calls', target: changed!.id }),
      ]));
      expect(synthesized(changed!.id, onChanged!.id)).toMatchObject({
        metadata: expect.objectContaining({ registeredAt: 'Main.qml:4' }),
      });
      expect(synthesized(changed!.id, apply!.id)).toMatchObject({
        metadata: expect.objectContaining({ registeredAt: 'connections.cpp:4' }),
      });
      expect(synthesized(refreshed!.id, update!.id)).toMatchObject({
        metadata: expect.objectContaining({ registeredAt: 'connections.cpp:7' }),
      });
    } finally {
      graph.close();
    }
  });

  it('does not synthesize a SIGNAL/SLOT connection with an ambiguous signal owner', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-qt-signal-ambiguous-'));
    write('first.h', `#include <QObject>
class Sender : public QObject {
    Q_OBJECT
signals:
    void changed();
};
`);
    write('second.h', `#include <QObject>
class Sender : public QObject {
    Q_OBJECT
signals:
    void changed();
};
`);
    write('receiver.h', `#include <QObject>
class Receiver : public QObject {
    Q_OBJECT
public slots:
    void apply();
};
`);
    write('connections.cpp', `#include "first.h"
#include "receiver.h"
void wire(Sender *sender, Receiver *receiver) {
    QObject::connect(sender, SIGNAL(changed()), receiver, SLOT(apply()));
}
`);

    const graph = CodeGraph.initSync(dir);
    try {
      expect((await graph.indexAll()).success).toBe(true);
      const signals = ['first.h', 'second.h'].flatMap((filePath) =>
        graph.getNodesInFile(filePath).filter((node) => node.name === 'changed'),
      );
      const slot = graph.getNodesInFile('receiver.h').find((node) => node.name === 'apply');

      expect(signals).toHaveLength(2);
      expect(slot).toBeDefined();
      for (const signal of signals) {
        expect(graph.getOutgoingEdges(signal.id)).not.toEqual(expect.arrayContaining([
          expect.objectContaining({
            kind: 'calls',
            target: slot!.id,
            provenance: 'heuristic',
            metadata: expect.objectContaining({ synthesizedBy: 'qt-signal-channel' }),
          }),
        ]));
      }
    } finally {
      graph.close();
    }
  });
});