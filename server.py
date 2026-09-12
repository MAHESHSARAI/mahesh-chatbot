from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import json
import urllib.error
import urllib.request

HOST = "127.0.0.1"
PORT = 8000
OLLAMA_URL = "http://127.0.0.1:11434"
STATIC_DIR = Path(__file__).parent / "static"


class ChatHandler(BaseHTTPRequestHandler):
    def _send_json(self, status, payload):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _read_json(self):
        length = int(self.headers.get("Content-Length", "0"))
        return json.loads(self.rfile.read(length))

    def do_GET(self):
        if self.path == "/api/models":
            try:
                with urllib.request.urlopen(f"{OLLAMA_URL}/api/tags", timeout=5) as response:
                    self._send_json(200, json.load(response))
            except (urllib.error.URLError, TimeoutError) as error:
                self._send_json(503, {"error": f"Ollama is unavailable: {error}"})
            return

        file_path = STATIC_DIR / ("index.html" if self.path == "/" else self.path.lstrip("/"))
        if not file_path.is_file() or STATIC_DIR not in file_path.parents:
            self.send_error(404)
            return

        content_type = {
            ".html": "text/html; charset=utf-8",
            ".css": "text/css; charset=utf-8",
            ".js": "application/javascript; charset=utf-8",
        }.get(file_path.suffix, "application/octet-stream")
        body = file_path.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        if self.path != "/api/chat":
            self.send_error(404)
            return

        try:
            request = self._read_json()
            model = request.get("model")
            messages = request.get("messages")
            if not model or not isinstance(messages, list) or not messages:
                self._send_json(400, {"error": "A model and at least one message are required."})
                return

            payload_dict = {"model": model, "messages": messages, "stream": True}
            payload = json.dumps(payload_dict).encode("utf-8")
            ollama_request = urllib.request.Request(
                f"{OLLAMA_URL}/api/chat",
                data=payload,
                headers={"Content-Type": "application/json"},
            )
            with urllib.request.urlopen(ollama_request, timeout=300) as response:
                self.send_response(200)
                self.send_header("Content-Type", "application/x-ndjson")
                self.send_header("Cache-Control", "no-cache")
                self.send_header("Connection", "keep-alive")
                self.end_headers()
                for line in response:
                    self.wfile.write(line)
                    self.wfile.flush()
                    try:
                        if json.loads(line).get("done"):
                            break
                    except json.JSONDecodeError:
                        continue
        except json.JSONDecodeError:
            self._send_json(400, {"error": "Request body must be valid JSON."})
        except urllib.error.HTTPError as error:
            detail = error.read().decode("utf-8", errors="replace")
            self._send_json(error.code, {"error": detail})
        except (urllib.error.URLError, TimeoutError) as error:
            self._send_json(503, {"error": f"Ollama is unavailable: {error}"})

    def log_message(self, format_string, *args):
        print(f"{self.address_string()} - {format_string % args}")


if __name__ == "__main__":
    server = ThreadingHTTPServer((HOST, PORT), ChatHandler)
    print(f"Mahesh Chatbot is running at http://localhost:{PORT}")
    print("Press Ctrl+C to stop the server.")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nServer stopped.")
    finally:
        server.server_close()
