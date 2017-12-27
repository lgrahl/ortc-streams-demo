"use strict";

const { ReadableStream } = require("streams/reference-implementation/lib/readable-stream.js");
const { WritableStream } = require("streams/reference-implementation/lib/writable-stream.js");
const { TransformStream } = require("streams/reference-implementation/lib/transform-stream.js");
const ByteLengthQueuingStrategy = require("node_modules/streams/reference-implementation/lib/byte-length-queuing-strategy.js");

const getUrlParameter = (name) => {
    return decodeURIComponent((new RegExp("[?|&]" + name + "=" + "([^&;]+?)(&|#|;|$)").exec(location.search) || [null, ""])[1].replace(/\+/g, "%20")) || null;
};

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function getRandomInt(min, max) {
    return Math.floor(Math.random() * (max - min + 1) + min);
}

const RTCQuicStreamState = {
    NEW: "new",
    OPENING: "opening",
    OPEN: "open",
    CLOSING: "closing",
    CLOSED: "closed"
};

class NativeQuicStream {
    static get defaultChunkSize() { return 128; }
    static get readHighWaterMark() { return 8 * NativeQuicStream.defaultChunkSize; }
    static get writeHighWaterMark() { return 8 * NativeQuicStream.defaultChunkSize; }
    static get defaultWriteLowWaterMark() { return NativeQuicStream.writeHighWaterMark / 4; }

    constructor() {
        this.readableController = null;
        this.writableController = null;
        this.readableStreamCancelled = false;
        this.writableStreamAborted = false;
        this.targetWriteBufferedAmount = NativeQuicStream.defaultWriteLowWaterMark;
        this.isReset = false;
        this._readTimer = null;
        this._drainTimer = null;
        this._eofCounter = 10;
        this._writeBufferedAmount = 0;
    }

    _readInto(view) {
        console.log("< Native: Feeding chunk of length " + view.byteLength +
                    " (offset=" + view.byteOffset + ")");
        window.crypto.getRandomValues(view);
        return view.byteLength;
    }

    get readBufferedAmount() {
        const desiredSize = this.readableController.desiredSize || 0;
        return NativeQuicStream.readHighWaterMark - desiredSize;
    }

    get writeBufferedAmount() {
        return this._writeBufferedAmount;
    }

    pauseReading() {
        console.log("< Native: Pause reading");
        if (this._readTimer !== null) {
            window.clearInterval(this._readTimer);
            this._readTimer = null;
        }
    }

    resumeReading() {
        console.log("< Native: Resume reading");
        if (this._readTimer === null) {
            this._readTimer = window.setInterval(() => { this.read(); }, 1000);
        }
    }

    finish() {
        // Note: The WritableStream guarantees that this will be called after
        //       all write calls have succeeded.

        console.log("> Native: Finishing stream");

        // Send FIN
        // ...

        // Note: We could theoretically feed back a Promise that
        //       resolves when the stream state goes into 'closing'.
    }

    reset(reason) {
        // Already reset?
        if (this.isReset) {
            return;
        }

        console.log("! Native: Resetting stream (reason: " + reason + ")");
        const error = "Stream reset, reason: " + reason;
        this.isReset = true;
        if (!this.readableStreamCancelled) {
            console.log("< Native: Resetting");
            this.readableController.error(error);
        }
        if (!this.writableStreamAborted) {
            console.log("> Native: Resetting");
            this.writableController.error(error);
        }
        console.log("! Native: Reset complete");

        // Send RST_STREAM
        // ...

        // Note: We could theoretically feed back a Promise that
        //       resolves when the stream state goes into 'closed'.
    }

    read() {
        // Reset?
        if (this.isReset) {
            return;
        }

        // Done reading?
        if (this._eofCounter <= 0) {
            window.clearInterval(this._readTimer);
            this._readTimer = null;
            return;
        }

        // If the reader is fast enough, the data can be fed directly into
        // the buffer provided by the reader.
        //
        // If not, we need to copy the current chunk and pause the underlying
        // source.
        const request = this.readableController.byobRequest;
        if (request) {
            console.log("< Native: Have pending BYOB request");
            const bytesRead = this._readInto(request.view);
            request.respond(bytesRead);
        } else {
            console.log("< Native: No pending BYOB request");
            const chunk = new Uint8Array(this.readableController.desiredSize);
            this._readInto(chunk);
            this.readableController.enqueue(chunk);

            // Pause the underlying source
            this.pauseReading();
        }

        // Feed EOF?
        this._eofCounter--;
        if (this._eofCounter === 0) {
            this.readableController.close();
        }
    }

    async write(view) {
        // Cancel pending (simulated) drains
        if (this._drainTimer) {
            window.clearInterval(this._drainTimer);
            this._drainTimer = null;
        }

        // Reject if data is too large to be buffered
        const length = view.byteLength;
        if (length + this._writeBufferedAmount > NativeQuicStream.writeHighWaterMark) {
            throw new DOMException("Buffer too full!", "OperationError")
        }

        // Write data
        this._writeBufferedAmount += length;
        console.log("> Native: Feeding chunk of length " + length +
                    " (offset=" + view.byteOffset + ")");

        // Drain to the target write buffered amount (or below)
        const drainLength = Math.max(
            0, this._writeBufferedAmount - this.targetWriteBufferedAmount);
        console.log("> Native: Drain length:", drainLength);

        // This promise here should return once the write buffer has reached
        // the low water mark.
        //
        // Note: The WritableStream guarantees that the 'write' calls remain
        //       in call order even if we return a Promise.
        await sleep(drainLength);

        // Simulate amount drained
        // Note: We need to catch a reset in between
        if (this.isReset) {
            return;
        }
        this._writeBufferedAmount -= drainLength;
        console.log("> Native: Drained to", this._writeBufferedAmount);

        // Drain further (async)
        if (this._writeBufferedAmount > 0) {
            this._drainTimer = setTimeout(() => {
                // We need to catch a reset in between
                if (this.isReset) {
                    return;
                }
                this._writeBufferedAmount = 0;
                console.log("> Native: Drained to 0");
            }, this._writeBufferedAmount);
        }
    }
}

class RTCQuicStream {
    constructor() {
        this._state = RTCQuicStreamState.NEW;
        this.onstatechange = null;

        this._nativeStream = new NativeQuicStream();
        const self = this;

        // Create ready reading/writing futures
        let resolve_;
        let reject_;
        this._readyReading = new Promise((resolve, reject) => {
            resolve_ = resolve;
            reject_ = reject;
        });
        this._readyReading.resolve = resolve_;
        this._readyReading.reject = reject_;
        this._readyWriting = new Promise((resolve, reject) => {
            resolve_ = resolve;
            reject_ = reject;
        });
        this._readyWriting.resolve = resolve_;
        this._readyWriting.reject = reject_;

        // Create readable stream
        this._readableStream = new ReadableStream({
            // If the underlyingSource object contains a property type set to
            // "bytes", this readable stream is a readable byte stream, and can
            // successfully vend BYOB readers. In that case, the passed
            // controller object will be an instance of
            // `ReadableByteStreamController`.
            type: "bytes", // Important!

            // For readable byte streams, underlyingSource can also contain
            // a property 'autoAllocateChunkSize', which can be set to a
            // positive integer to enable the auto-allocation feature for this
            // stream. In that case, when a consumer uses a default reader, the
            // stream implementation will automatically allocate an
            // `ArrayBuffer` of the given size, and call the underlying source
            // code as if the consumer was using a BYOB reader.
            autoAllocateChunkSize: NativeQuicStream.defaultChunkSize, // Important!

            start(controller) {
                self._nativeStream.readableController = controller;
                return self._readyReading;
            },

            pull() {
                // Resume underlying source
                return self._nativeStream.resumeReading();
            },

            cancel() {
                // Reset stream
                self._nativeStream.readableStreamCancelled = true;
                return self._reset("Cancelled by ReadableStream");
            }
        }, {
            highWaterMark: NativeQuicStream.readHighWaterMark
        });

        // Create writable stream
        this._writableStream = new WritableStream({
            start(controller) {
                self._nativeStream.writableController = controller;
                return self._readyWriting;
            },

            write(chunk) {
                // Pass chunk to the underlying source
                return self._nativeStream.write(chunk);
            },

            close() {
                // Finish stream.
                return self._nativeStream.finish();
            },

            abort() {
                // Reset stream
                self._nativeStream.writableStreamAborted = true;
                return self._reset("Aborted WritableStream");
            }
        }, new ByteLengthQueuingStrategy({
            highWaterMark: NativeQuicStream.writeHighWaterMark
        }));

        // Simulate transition to 'OPENING' and 'OPEN'
        setTimeout(() => {
            if (this.state === RTCQuicStreamState.NEW) {
                this._setState(RTCQuicStreamState.OPENING);
            }
        }, 1000);
        setTimeout(() => {
            if (this.state === RTCQuicStreamState.OPENING) {
                this._setState(RTCQuicStreamState.OPEN);
            }
        }, 1500);
    }

    _setState(state) {
        // Filter states raised twice
        if (this._state === state) {
            return;
        }

        // Resolve ready writing on 'OPENING'
        if (state === RTCQuicStreamState.OPENING) {
            this._readyWriting.resolve();
        }

        // Resolve ready reading on 'OPEN'
        if (state === RTCQuicStreamState.OPEN) {
            this._readyReading.resolve();
        }

        // Set state and call event handler (if any)
        this._state = state;
        if (this.onstatechange) {
            this.onstatechange(state);
        }
    }

    _reset(reason) {
        // N: Reject ready reading/writing futures
        this._readyReading.reject("Reset: " + reason);
        this._readyWriting.reject("Reset: " + reason);

        // 2.
        if (this.state === RTCQuicStreamState.NEW) {
            this._setState(RTCQuicStreamState.CLOSED);
            return;
        }

        // 3.
        if (this.state === RTCQuicStreamState.CLOSED) {
            return;
        }

        // 4.
        this._nativeStream.reset(reason);

        // 5.
        this._setState(RTCQuicStreamState.CLOSING);
    }

    get transport() {
        return null;
    }

    get state() {
        return this._state;
    }

    get readBufferedAmount() {
        return this._nativeStream.readBufferedAmount;
    }

    get maxReadBufferedAmount() {
        return NativeQuicStream.readHighWaterMark;
    }

    get writeBufferedAmount() {
        return this._nativeStream.writeBufferedAmount;
    }

    get maxWriteBufferedAmount() {
        return NativeQuicStream.writeHighWaterMark;
    }

    get targetWriteBufferedAmount() {
        return this._nativeStream.targetWriteBufferedAmount;
    }

    get readableStream() {
        return this._readableStream;
    }

    get writableStream() {
        return this._writableStream;
    }

    reset() {
        this._reset("Reset on RTCQuicStream")
    }

    setTargetWriteBufferedAmount(amount) {
        // 3.
        if (amount > this.maxWriteBufferedAmount) {
            throw new DOMException("amount > maxWriteBufferedAmount", "OperationError")
        }

        // 4.
        this._nativeStream.targetWriteBufferedAmount = amount;

        // 5. Will be applied on next Writer.write call
    }
}

async function startReadingBYOB(options, stream) {
    // Create reader & buffer
    let reader = stream.readableStream.getReader({ mode: "byob" });
    console.log("< READER", reader);
    const buffer = new Uint8Array(1024);
    let view = new DataView(buffer.buffer, 0);
    let total = 0;

    console.info("< READING (maxReadBufferedAmount=" + stream.maxReadBufferedAmount + ")");
    for (let i = 0; ; ++i) {
        let chunk;

        // Get next chunk
        console.log("< BUFFERED:", stream.readBufferedAmount);
        try {
            chunk = await reader.read(view);
        } catch (error) {
            console.warn("< READING CANCELLED", error);
            break;
        }

        total += chunk.done ? 0 : chunk.value.byteLength;
        console.log("< CHUNK " + (i + 1) + " done:", chunk.done,
                    "length:", chunk.done ? 0 : chunk.value.byteLength,
                    "total:", total,
                    "data:", chunk.done ? "N/A" : new Uint8Array(chunk.value.buffer));
        if (chunk.done) {
            break;
        }

        // Reclaim the buffer
        view = chunk.value;

        // Test reset behaviour
        if (i + 1 === options.resetRead) {
            if (options.resetStream) {
                stream.reset();
                if (options.resetTwice) {
                    stream.reset();
                }
            } else {
                reader.cancel();
                if (options.resetTwice) {
                    reader.cancel();
                }
            }
        }

        // Provoke both pending BYOB request and no request
        const ms = getRandomInt(900, 1100);
        await sleep(ms);
    }
}

async function startReadingDefault(options, stream) {
    // Create reader
    let reader = stream.readableStream.getReader();
    console.log("< READER", reader);
    let total = 0;

    console.info("< READING (maxReadBufferedAmount=" + stream.maxReadBufferedAmount + ")");
    for (let i = 0; ; ++i) {
        let chunk;

        // Get next chunk
        console.log("< BUFFERED:", stream.readBufferedAmount);
        try {
            chunk = await reader.read();
        } catch (error) {
            console.warn("< READING CANCELLED", error);
            break;
        }

        total += chunk.done ? 0 : chunk.value.byteLength;
        console.log("< CHUNK " + (i + 1) + " done:", chunk.done,
                    "length:", chunk.done ? 0 : chunk.value.byteLength,
                    "total:", total,
                    "data:", chunk.done ? "N/A" : new Uint8Array(chunk.value.buffer));
        if (chunk.done) {
            break;
        }

        // Test reset behaviour
        if (i + 1 === options.resetRead) {
            if (options.resetStream) {
                stream.reset();
                if (options.resetTwice) {
                    stream.reset();
                }
            } else {
                reader.cancel();
                if (options.resetTwice) {
                    reader.cancel();
                }
            }
        }

        // Provoke both pending BYOB request and no request
        const ms = getRandomInt(900, 1100);
        await sleep(ms);
    }
}

async function startWritingDefault(options, stream) {
    // Create writer
    const writer = stream.writableStream.getWriter();
    console.log("> WRITER", writer);
    let total = 0;

    console.info("> WRITING (maxWriteBufferedAmount=" + stream.maxWriteBufferedAmount + ")");
    for (let i = 0; i < 6; ++i) {
        const done = (i === 5);

        // Until the WHATWG streams spec has defined a WritableStreamBYOBWriter
        // we need to provide a unique buffer on each write.
        // See: https://github.com/whatwg/streams/issues/495
        //
        // An alternative is to call `setTargetWriteBufferedAmount(0)` and
        // `await` each `write` call. However, this may have other
        // drawbacks regarding throughput.
        const buffer = new Uint8Array(options.testBufferFull ?
            stream.maxWriteBufferedAmount :
            writer.desiredSize);

        // Generate data depending on desired size
        //const length = Math.min(buffer.byteLength, writer.desiredSize)
        const length = buffer.byteLength;
        const view = new Uint8Array(buffer.buffer, 0, length);
        window.crypto.getRandomValues(view);

        total += view.byteLength;
        console.log("> CHUNK " + (i + 1) + " done:", done,
                    "length:", length,
                    "total:", total,
                    "data:", view);

        // Test reset behaviour
        if (i + 1 === options.resetWrite) {
            if (options.resetStream) {
                stream.reset();
                if (options.resetTwice) {
                    stream.reset();
                }
            } else {
                writer.abort();
                if (options.resetTwice) {
                    writer.abort();
                }
            }
        }

        // Write chunk
        console.log("> BUFFERED(targetWriteBufferedAmount=" + stream.targetWriteBufferedAmount +
                    "):", stream.writeBufferedAmount);
        try {
            // One needs to be careful here if the buffer is supposed to be
            // reused
            await writer.write(view);

            // Close?
            if (done) {
                await writer.close();
            }
        } catch (error) {
            // Try again with a smaller buffer
            if (error.message === "Buffer too full!") {
                console.log("> CHUNK TOO LARGE", error);
                options.testBufferFull = false;
            } else {
                console.warn("> WRITING CANCELLED", error);
                break;
            }
        }

        // Adjust target write buffered amount on-the-fly
        if (i == 3) {
            stream.setTargetWriteBufferedAmount(50);
        }
    }
}

async function startPiping(options, stream) {
    console.log("<> PIPING");
    await stream.readableStream.pipeTo(stream.writableStream);
}

async function start() {
    // Get options
    const options = (() => {
        // Call reset twice when resetting?
        let resetTwice = getUrlParameter("resetTwice");
        resetTwice = (resetTwice == "true" || resetTwice == "1");

        // Reset stream? Defaults to reader.cancel()/writer.abort() if not set
        let resetStream = getUrlParameter("resetStream");
        resetStream = (resetStream == "true" || resetStream == "1");

        // Reset after having read #resetRead chunks?
        const resetRead = parseInt(getUrlParameter("resetRead"));

        // Reset after having written #resetWrite chunks?
        const resetWrite = parseInt(getUrlParameter("resetWrite"));

        // Use default reader? Defaults to BYOB reader.
        let defaultReader = getUrlParameter("defaultReader");
        defaultReader = (defaultReader == "true" || defaultReader == "1");

        // Pipe readable stream directly to writable stream? Defaults to no.
        let pipeTo = getUrlParameter("pipeTo");
        pipeTo = (pipeTo == "true" || pipeTo == "1");

        // Test buffer full error
        let testBufferFull = getUrlParameter("testBufferFull");
        testBufferFull = (testBufferFull == "true" || testBufferFull == "1");

        return {
            resetTwice: resetTwice,
            resetStream: resetStream,
            resetRead: resetRead,
            resetWrite: resetWrite,
            defaultReader: defaultReader,
            pipeTo: pipeTo,
            testBufferFull: testBufferFull,
        };
    })();
    console.log("! OPTIONS", options);

    // Select reader/writer
    const startReading = options.defaultReader ? startReadingDefault : startReadingBYOB;
    const startWriting = startWritingDefault; // TODO: Add BYOB here once it's specified

    // Create stream & promises
    const stream = new RTCQuicStream();

    // Handle state change
    stream.onstatechange = (state) => {
        console.log("! STREAM STATE:", state);
    };

    // Wait until reading and writing is complete
    console.log("! STREAM", stream);
    if (options.pipeTo) {
        await startPiping(options, stream);
    } else {
        await Promise.all([
            startReading(options, stream),
            startWriting(options, stream)
        ]);
    }
}

console.info("! START");
start()
.then(() => {
    console.info("! DONE");
})
.catch((error) => {
    console.error("! ERROR", error);
});
