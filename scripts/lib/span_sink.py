#!/usr/bin/env python3
"""A stand-in trace agent that records what the tracers actually send.

Phase 8 asks us to prove that sixteen named spans exist and carry twelve named
tags. There is no way to ask the Datadog API that question without an
application key, and the real Agent's status output names only the top-level
service on each payload -- so a child span like `search.fanout` is invisible
there no matter how correct it is.

This listens on the trace endpoints, decodes the msgpack payload, and writes
one JSON line per span. Point a service at it with DD_TRACE_AGENT_PORT and the
spans it emits become greppable text.

It is a test fixture. It never runs in the stack, acknowledges everything with
an empty rate-by-service map, and keeps nothing in memory.
"""

from __future__ import annotations

import json
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


def decode(data: bytes, at: int = 0):
    """Enough of msgpack to read a trace payload.

    Vendoring a decoder rather than depending on the msgpack package keeps this
    runnable in a bare python:3.12-slim container with no pip step, which is
    the whole reason the script is quick enough to be worth running.
    """
    byte = data[at]
    at += 1

    if byte <= 0x7F:
        return byte, at
    if byte >= 0xE0:
        return byte - 0x100, at
    if 0x80 <= byte <= 0x8F:
        return _map(data, at, byte & 0x0F)
    if 0x90 <= byte <= 0x9F:
        return _array(data, at, byte & 0x0F)
    if 0xA0 <= byte <= 0xBF:
        return _str(data, at, byte & 0x1F)

    if byte == 0xC0:
        return None, at
    if byte == 0xC2:
        return False, at
    if byte == 0xC3:
        return True, at

    if byte in (0xC4, 0xC5, 0xC6):  # bin 8/16/32
        width = {0xC4: 1, 0xC5: 2, 0xC6: 4}[byte]
        size = int.from_bytes(data[at : at + width], "big")
        at += width
        return data[at : at + size], at + size

    if byte == 0xCA:
        return _float(data, at, 4)
    if byte == 0xCB:
        return _float(data, at, 8)

    if 0xCC <= byte <= 0xCF:  # uint 8/16/32/64
        width = 1 << (byte - 0xCC)
        return int.from_bytes(data[at : at + width], "big"), at + width
    if 0xD0 <= byte <= 0xD3:  # int 8/16/32/64
        width = 1 << (byte - 0xD0)
        return int.from_bytes(data[at : at + width], "big", signed=True), at + width

    if byte in (0xD9, 0xDA, 0xDB):  # str 8/16/32
        width = {0xD9: 1, 0xDA: 2, 0xDB: 4}[byte]
        size = int.from_bytes(data[at : at + width], "big")
        return _str(data, at + width, size)

    if byte in (0xDC, 0xDD):  # array 16/32
        width = 2 if byte == 0xDC else 4
        size = int.from_bytes(data[at : at + width], "big")
        return _array(data, at + width, size)

    if byte in (0xDE, 0xDF):  # map 16/32
        width = 2 if byte == 0xDE else 4
        size = int.from_bytes(data[at : at + width], "big")
        return _map(data, at + width, size)

    raise ValueError(f"unsupported msgpack byte 0x{byte:02x} at {at - 1}")


def _str(data: bytes, at: int, size: int):
    return data[at : at + size].decode("utf-8", "replace"), at + size


def _array(data: bytes, at: int, size: int):
    items = []
    for _ in range(size):
        item, at = decode(data, at)
        items.append(item)
    return items, at


def _map(data: bytes, at: int, size: int):
    out = {}
    for _ in range(size):
        key, at = decode(data, at)
        value, at = decode(data, at)
        out[key] = value
    return out, at


def _float(data: bytes, at: int, width: int):
    import struct

    fmt = ">f" if width == 4 else ">d"
    return struct.unpack(fmt, data[at : at + width])[0], at + width


class Handler(BaseHTTPRequestHandler):
    def do_PUT(self):  # noqa: N802 -- BaseHTTPRequestHandler's naming
        self._collect()

    def do_POST(self):  # noqa: N802
        self._collect()

    def do_GET(self):  # noqa: N802
        # The tracers probe /info at startup to decide which endpoint version
        # to use. A 404 here is harmless but makes them fall back and log a
        # warning, which is noise in the very output we are trying to read.
        self._reply(b'{"endpoints":["/v0.4/traces"]}')

    def _collect(self):
        body = self._body()
        self._reply(b"{}")

        if not body:
            return

        # LLM Observability does not travel with the traces. The tracer keeps
        # the LLMObs span events in a separate writer and posts them as JSON
        # through the Agent's EVP proxy, and the trace payload is stripped of
        # the `_ml_obs.*` tags on the way past -- so the token counts and the
        # cost only exist on this endpoint. Phase 10 asks us to prove they are
        # there, and this is the only place they can be read without an
        # application key.
        if "api/v2/llmobs" in self.path:
            self._collect_llmobs(body)
            return

        # The tracers also post telemetry, runtime metrics and stats to this
        # host. Those are valid msgpack or JSON and would decode into
        # something that is simply not a list of traces.
        if "/traces" not in self.path:
            return
        try:
            traces, _ = decode(body)
        except Exception as error:  # noqa: BLE001 -- a bad payload must not stop the sink
            print(f"# undecodable payload: {error}", file=sys.stderr, flush=True)
            return

        if not isinstance(traces, list):
            return

        # v0.5 sends [string_table, traces]; v0.4 sends traces directly.
        if len(traces) == 2 and isinstance(traces[0], list) and traces[0] and isinstance(traces[0][0], str):
            traces = _resolve_v05(traces)

        for trace in traces or []:
            for span in trace or []:
                if not isinstance(span, dict):
                    continue
                print(
                    json.dumps(
                        {
                            "name": span.get("name"),
                            "service": span.get("service"),
                            "resource": span.get("resource"),
                            "error": span.get("error", 0),
                            "meta": span.get("meta") or {},
                        },
                        sort_keys=True,
                    ),
                    flush=True,
                )

    def _collect_llmobs(self, body: bytes):
        try:
            payload = json.loads(body)
        except ValueError as error:
            print(f"# undecodable llmobs payload: {error}", file=sys.stderr, flush=True)
            return

        for event in payload.get("spans") or []:
            if not isinstance(event, dict):
                continue
            # Marked, because these share a file with the APM span lines and
            # an assertion that cannot tell them apart would count a `tool`
            # span twice or look for token counts on the wrong one.
            print(json.dumps({"llmobs": True, **event}, sort_keys=True), flush=True)

    def _body(self) -> bytes:
        """Reads the request body, chunked or not.

        dd-trace-go streams its payload with Transfer-Encoding: chunked and
        sends no Content-Length at all, so a sink that only honours the header
        silently records nothing from exactly the services this is here to
        check.
        """
        if "chunked" in (self.headers.get("transfer-encoding") or "").lower():
            chunks = []
            while True:
                size = int(self.rfile.readline().split(b";")[0] or b"0", 16)
                if size == 0:
                    self.rfile.readline()
                    break
                chunks.append(self.rfile.read(size))
                self.rfile.readline()
            return b"".join(chunks)
        return self.rfile.read(int(self.headers.get("content-length") or 0))

    def _reply(self, body: bytes):
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *_args):
        """Silent. The span lines are the output; access logs would drown them."""


def _resolve_v05(payload):
    """v0.5 replaces every string with an index into a shared table."""
    table, traces = payload
    resolved = []
    for trace in traces:
        spans = []
        for span in trace:
            # Positional: service, name, resource, trace_id, span_id, parent_id,
            # start, duration, error, meta, metrics, type.
            meta = {table[k]: table[v] for k, v in (span[9] or {}).items()}
            spans.append(
                {
                    "service": table[span[0]],
                    "name": table[span[1]],
                    "resource": table[span[2]],
                    "error": span[8],
                    "meta": meta,
                }
            )
        resolved.append(spans)
    return resolved


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8126
    ThreadingHTTPServer(("0.0.0.0", port), Handler).serve_forever()
