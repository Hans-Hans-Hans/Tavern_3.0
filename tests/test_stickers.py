import copy
import unittest
from types import SimpleNamespace
from synapse_modules.tavern_policy import STICKERS, check_sticker_pack, valid_sticker_pack

def event(kind, body, key='', eid='$old'):
    return SimpleNamespace(type=kind, content=body, state_key=key, event_id=eid, sender='@owner:local')

class StickerTests(unittest.TestCase):
    def setUp(self):
        self.data={'version':1,'name':'Cats','stickers':[{'id':'cat','name':'Wave','alt':'A cat waving','url':'mxc://local/image'}],'io.tavern.previous_event':None}
        self.state={('m.room.create',''):event('m.room.create',{'type':'m.space','m.federate':False}),('m.room.member','@owner:local'):event('m.room.member',{'membership':'join'})}
    def test_artwork_and_limits(self):
        self.assertTrue(valid_sticker_pack('pack',self.data))
        for change in ({'url':'https://tracker.test/image'},{'alt':''},{'id':'../cat'},{'name':'x'*61}):
            proposed=copy.deepcopy(self.data);proposed['stickers'][0].update(change)
            self.assertFalse(valid_sticker_pack('pack',proposed))
        proposed=copy.deepcopy(self.data);proposed['stickers']*=51
        self.assertFalse(valid_sticker_pack('pack',proposed))
    def test_saved_revision_and_server_membership(self):
        proposal=event(STICKERS,self.data,'pack')
        self.assertTrue(check_sticker_pack(proposal,self.state))
        self.state[(STICKERS,'pack')]=event(STICKERS,self.data,'pack')
        self.assertFalse(check_sticker_pack(proposal,self.state))
        self.data['io.tavern.previous_event']='$old'
        self.assertTrue(check_sticker_pack(proposal,self.state))
        self.state[('m.room.member','@owner:local')].content={'membership':'leave'}
        self.assertFalse(check_sticker_pack(proposal,self.state))
    def test_twenty_pack_limit_and_tombstone_recreation(self):
        for i in range(20):self.state[(STICKERS,str(i))]=event(STICKERS,self.data,str(i))
        self.assertFalse(check_sticker_pack(event(STICKERS,self.data,'new'),self.state))
        self.state[(STICKERS,'0')].content={'version':1,'deleted':True}
        self.assertTrue(check_sticker_pack(event(STICKERS,self.data,'new'),self.state))
