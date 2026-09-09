"""TLS-only SMTP sink for the isolated live browser test. Never forwards email."""
import asyncio
from email import policy
from email.parser import BytesParser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import ssl
import threading

if os.environ.get('TAVERN_CI_SMOKE') != 'true':
    raise RuntimeError('This mail sink is restricted to CI.')

messages = []
lock = threading.Lock()


class HTTP(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path not in ('/health', '/messages'):
            self.send_error(404)
            return
        with lock:
            data = json.dumps({'ok': True} if self.path == '/health' else {'messages': messages}).encode()
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, *args):
        pass


async def smtp(reader, writer):
    async def reply(value):
        writer.write((value + '\r\n').encode())
        await writer.drain()
    await reply('220 tavern-ci-mail ESMTP')
    try:
        while line := await asyncio.wait_for(reader.readline(), 30):
            verb = line.decode(errors='replace').split(' ', 1)[0].strip().upper()
            if verb in ('EHLO', 'HELO'):
                await reply('250 tavern-ci-mail')
            elif verb in ('MAIL', 'RCPT', 'RSET', 'NOOP'):
                await reply('250 OK')
            elif verb == 'DATA':
                await reply('354 End with a single period')
                content = bytearray()
                while (part := await asyncio.wait_for(reader.readline(), 30)) not in (b'.\r\n', b'.\n', b''):
                    content.extend(part[1:] if part.startswith(b'..') else part)
                    if len(content) > 2 * 1024 * 1024:
                        raise ValueError('CI message too large')
                message = BytesParser(policy=policy.default).parsebytes(content)
                body = message.get_body(preferencelist=('plain',))
                with lock:
                    messages.append({'to': str(message.get('To', '')), 'subject': str(message.get('Subject', '')), 'text': body.get_content() if body else ''})
                    del messages[:-100]
                await reply('250 Message captured locally')
            elif verb == 'QUIT':
                await reply('221 Bye')
                break
            else:
                await reply('502 Unsupported CI command')
    except (ValueError, OSError, asyncio.TimeoutError):
        pass
    finally:
        writer.close()
        await writer.wait_closed()


async def main():
    tls = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    directory = Path(os.environ.get('CI_TLS_DIR', '/ci/tls'))
    tls.load_cert_chain(directory / 'cert.pem', directory / 'key.pem')
    threading.Thread(target=ThreadingHTTPServer(('0.0.0.0', 8085), HTTP).serve_forever, daemon=True).start()
    async with await asyncio.start_server(smtp, '0.0.0.0', 1465, ssl=tls) as server:
        await server.serve_forever()


asyncio.run(main())
