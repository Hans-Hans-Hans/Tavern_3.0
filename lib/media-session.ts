let owner:'direct'|'conference'|null=null;
export function claimMedia(kind:'direct'|'conference',reuse=false){if(owner&&(!reuse||owner!==kind))throw new Error('Leave the current call before starting another.');owner=kind;}
export function releaseMedia(kind:'direct'|'conference'){if(owner===kind)owner=null;}
export function mediaOwner(){return owner;}
