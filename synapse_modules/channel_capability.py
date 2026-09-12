"""Internal, uncached proof that the running homeserver loaded admission hooks."""
import json


def install(api, worker):
    # Keep Twisted out of the companion API's read-only policy model import.
    from twisted.web.resource import Resource

    class Capability(Resource):
        isLeaf = True

        def render_GET(self, request):
            request.setHeader(b'Content-Type', b'application/json')
            request.setHeader(b'Cache-Control', b'no-store')
            return json.dumps({'version': 1, 'ready': bool(worker and worker.ready)}).encode()

    api.register_web_resource('/_tavern/channel-admission', Capability())
