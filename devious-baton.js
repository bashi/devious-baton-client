let app;

function addLog(text) {
  const log = document.getElementById("log");
  log.value += text + "\n";
  log.scrollTop = log.scrollHeight;
}

function addSendLog(baton, via) {
  addLog(`==> baton: ${baton} via ${via}`);
}

function addRecvLog(baton, from) {
  addLog(`<== baton: ${baton} from ${from}`);
}

class MessageReader {
  constructor(reader) {
    this.reader = reader;
    this.buf = new Uint8Array();
    this.done = false;
  }

  async ensureBuffer(length) {
    while (!this.done && this.buf.length < length) {
      const { value, done } = await this.reader.read();
      if (!value) {
        break;
      }
      this.buf = new Uint8Array([...this.buf, ...value]);
      this.done = done;
    }
    if (this.buf.length < length) {
      throw new Error("Not enough data");
    }
  }

  async readByte() {
    await this.ensureBuffer(1);
    const value = this.buf[0];
    this.buf = this.buf.subarray(1);
    return value;
  }

  async readBytes(length) {
    await this.ensureBuffer(length);
    const value = this.buf.subarray(0, length);
    this.buf = this.buf.subarray(length);
    return value;
  }

  async readVarint() {
    let value = await this.readByte();
    const prefix = value >>> 6;
    const length = 1 << prefix;

    value = value & 0x3f;
    for (let i = 0; i < length - 1; i++) {
      const b = await this.readByte();
      value = (value << 8) + b;
    }
    return value;
  }
}

async function readBatonMessage(reader, from) {
  let messageReader = new MessageReader(reader);
  const paddingLength = await messageReader.readVarint();
  const padding = await messageReader.readBytes(paddingLength);
  const baton = await messageReader.readByte();

  addRecvLog(baton, from);
  return { padding, baton };
}

// TODO: Support padding.
async function writeBatonMessage(writer, baton, via) {
  await writer.write(new Uint8Array([0, baton]));
  addSendLog(baton, via);
}

class App {
  constructor(url) {
    this.wt = new WebTransport(url);
    this.activeBatons = 1;

    this.incomingUniStreams = this.wt.incomingUnidirectionalStreams.getReader();
    this.incomingUniStreams.read().then(({ value: stream }) => this.handleUnidirectionalStream(stream)).catch(e => console.error(e));

    this.incomingBidiStreams = this.wt.incomingBidirectionalStreams.getReader();
    this.incomingBidiStreams.read().then(({ value: stream }) => this.handleBidirectionalStream(stream)).catch(e => console.error(e));
  }

  async handleUnidirectionalStream(stream) {
    if (!stream) {
      return;
    }

    const reader = stream.getReader();
    const message = await readBatonMessage(reader, "a peer initiated uni stream");
    reader.releaseLock();

    if (message.baton === 0) {
      this.decrementActiveBatons();
    } else {
      const nextBaton = (message.baton + 1) % 256;
      this.sendBatonViaBidirectionalStream(nextBaton);
    }

    if (this.activeBatons > 0) {
      await stream.cancel();
      this.incomingUniStreams.read().then(({ value: stream }) => this.handleUnidirectionalStream(stream)).catch(e => console.error(e));
    }
  }

  async handleBidirectionalStream(stream) {
    if (!stream) {
      return;
    }

    const reader = stream.readable.getReader();
    const message = await readBatonMessage(reader, "a peer initiated bidi stream");
    reader.releaseLock();

    if (message.baton === 0) {
      this.decrementActiveBatons();
    } else {
      const nextBaton = (message.baton + 1) % 256;

      const writer = stream.writable.getWriter();
      await writeBatonMessage(writer, nextBaton, "a peer initiated bidi stream");
      await writer.close();
    }

    if (this.activeBatons > 0) {
      this.incomingBidiStreams.read().then(({ value: stream }) => this.handleBidirectionalStream(stream)).catch(e => console.error(e));
    }
  }

  async decrementActiveBatons() {
    this.activeBatons -= 1;
    if (this.activeBatons === 0) {
      this.wt.close();
    }
  }

  async sendBatonViaBidirectionalStream(baton) {
    const stream = await this.wt.createBidirectionalStream();
    const writer = stream.writable.getWriter();

    await writeBatonMessage(writer, baton, "an opened bidi stream");
    await writer.close();

    const reader = stream.readable.getReader();
    const message = await readBatonMessage(reader, "an opened bidi stream");

    const nextBaton = (message.baton + 1) % 256;
    this.sendBatonViaUnidirectionalStream(nextBaton);
    await reader.cancel();
  }

  async sendBatonViaUnidirectionalStream(baton) {
    const stream = await this.wt.createUnidirectionalStream();
    const writer = stream.getWriter();
    await writeBatonMessage(writer, baton, "an opened uni stream");
    await writer.close();
  }
}

async function start() {
  const url = document.getElementById("url").value;
  app = new App(url);
}

document.addEventListener("DOMContentLoaded", () => {
  const button = document.getElementById("connect");
  button.addEventListener('click', () => {
    start();
  });
});
