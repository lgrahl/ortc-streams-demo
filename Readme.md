# ORTC Streams Demo

The spec can be found
[here](https://github.com/lgrahl/ortc/tree/quic-whatwg-streams) (WIP).

## Clone

```bash
git clone --recursive https://github.com/lgrahl/ortc-streams-demo.git
```

## Install

```bash
cd ortc-streams-demo
npm install
```

## Run

This runs `browserify` on `streams.js` and continues watching for changes.

```bash
npm start
```

Then, open `index.html` in a browser of your choice.

### Parameters

There are a bunch of parameters that trigger special behaviour. You can see
available parameter
[here](https://github.com/lgrahl/ortc-streams-demo/blob/437aaf19dfffa80286faf6d3e76eba49612df451/streams.js#L596:L632).

Set them by adding them to the query string, for example:

```
index.html?resetTwice=1&resetRead=3
```
