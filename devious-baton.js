let app;

function addLog(text) {
  const log = document.getElementById("log");
  log.value += text + "\n";
  log.scrollTop = log.scrollHeight;
}

function addSendLog(baton, via) {
  addLog(`==> baton: ${baton}, ${via}`);
}

function addRecvLog(baton, from) {
  addLog(`<== baton: ${baton}, ${from}`);
}

function addErrorLog(error) {
  addLog(`Error: ${error}`);
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
  constructor(url, activeBatons) {
    this.wt = new WebTransport(url);
    this.wt.closed.catch(e => addErrorLog(e));
    this.activeBatons = activeBatons;

    this.incomingUniStreams = this.wt.incomingUnidirectionalStreams.getReader();
    this.incomingUniStreams.read().then(({ value: stream }) => this.handleUnidirectionalStream(stream));

    this.incomingBidiStreams = this.wt.incomingBidirectionalStreams.getReader();
    this.incomingBidiStreams.read().then(({ value: stream }) => this.handleBidirectionalStream(stream));
  }

  async handleUnidirectionalStream(stream) {
    if (!stream) {
      return;
    }

    const reader = stream.getReader();
    const message = await readBatonMessage(reader, "RemoteUni");
    reader.releaseLock();

    if (message.baton === 0) {
      this.decrementActiveBatons();
    } else {
      const nextBaton = (message.baton + 1) % 256;
      this.sendBatonViaBidirectionalStream(nextBaton);
    }

    if (this.activeBatons > 0) {
      await stream.cancel();
      this.incomingUniStreams.read().then(({ value: stream }) => this.handleUnidirectionalStream(stream));
    }
  }

  async handleBidirectionalStream(stream) {
    if (!stream) {
      return;
    }

    const reader = stream.readable.getReader();
    const message = await readBatonMessage(reader, "RemoteBidi");
    reader.releaseLock();

    if (message.baton === 0) {
      this.decrementActiveBatons();
    } else {
      const nextBaton = (message.baton + 1) % 256;

      const writer = stream.writable.getWriter();
      await writeBatonMessage(writer, nextBaton, "RemoteBidi");
      await writer.close();
    }

    if (this.activeBatons > 0) {
      this.incomingBidiStreams.read().then(({ value: stream }) => this.handleBidirectionalStream(stream));
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

    await writeBatonMessage(writer, baton, "LocalBidi");
    await writer.close();

    const reader = stream.readable.getReader();
    const message = await readBatonMessage(reader, "LocalBidi");

    const nextBaton = (message.baton + 1) % 256;
    this.sendBatonViaUnidirectionalStream(nextBaton);
    await reader.cancel();
  }

  async sendBatonViaUnidirectionalStream(baton) {
    const stream = await this.wt.createUnidirectionalStream();
    const writer = stream.getWriter();
    await writeBatonMessage(writer, baton, "LocalUni");
    await writer.close();
  }
}

async function start() {
  const url = document.getElementById("url").value;
  // TODO: make configurable.
  const activeBatons = 1;
  app = new App(url, activeBatons);
}

document.addEventListener("DOMContentLoaded", () => {
  const button = document.getElementById("connect");
  button.addEventListener("click", start());
});
