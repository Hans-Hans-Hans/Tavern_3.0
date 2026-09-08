import hashlib
import hmac
from pathlib import Path
import sys
import unittest
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'integrations'))
from protocol import authenticate,transaction

class WebhookProtocol(unittest.TestCase):
    secret=b'x'*32;delivery='12345678-1234-4234-8234-123456789abc';timestamp='1000000000';body=b'{"text":"build passed"}'
    def signature(self,body=None,hook='builds'):
        data=b'v1\n'+hook.encode()+b'\n'+self.timestamp.encode()+b'\n'+self.delivery.encode()+b'\n'+(self.body if body is None else body)
        return 'sha256='+hmac.new(self.secret,data,hashlib.sha256).hexdigest()
    def test_valid_signature_and_stable_id(self):
        self.assertEqual(authenticate('builds',self.timestamp,self.delivery,self.signature(),self.body,self.secret,now=1000000000),'build passed')
        self.assertEqual(transaction('builds',self.delivery),transaction('builds',self.delivery))
        self.assertNotEqual(transaction('builds',self.delivery),transaction('other',self.delivery))
    def test_body_route_and_timestamp_are_authenticated(self):
        for hook,body,now in [('other',self.body,1000000000),('builds',b'{"text":"tampered"}',1000000000),('builds',self.body,1000000301)]:
            with self.assertRaises(ValueError):authenticate(hook,self.timestamp,self.delivery,self.signature(),body,self.secret,now=now)
    def test_rejects_extra_fields_and_oversized_content(self):
        for body in [b'{"text":"ok","room_id":"unapproved"}',b'{"text":""}',b'x'*16385]:
            with self.assertRaises(ValueError):authenticate('builds',self.timestamp,self.delivery,self.signature(body),body,self.secret,now=1000000000)
