# 4. Failover between a primary and a backup

- Status: Accepted
- Date: 2026-11-13

## Context

A show must keep running when the computer that drives it fails. Nightfall supports a pair of computers: a **primary** that runs the show and sends output, and a **backup** that follows it and can take over its output. The pair is two computers only, like a console with one backup, not a session of many stations.

Constraints:

- Show data is already captured as a `ShowfileSnapshot`, and opening a show is an atomic world swap, so a backup can load a copy of the primary's show the same way a client opens a show.
- Live state, such as what plays, fader levels, tempo and the programmer, is not part of the showfile.
- sACN receivers merge sources by priority, so a second source at a lower priority waits silently. Art-Net and USB DMX have no priority, so two computers sending them conflict.
- Controllers, timecode and other inputs reach only the computer they are plugged into.
- Hosts talk over the same HTTP server that clients use, which pairing with a PIN guards for other computers on the network.

## Decision

### Keep the backup in step

The backup follows the primary in three layers:

1. **Show copy.** The backup polls the primary's show revision, a hash of its live show, and downloads the show as an archive when the revision changes. The archive carries the audio, fixture profiles and FX modules the show uses. The backup loads it with a world swap.
2. **Forwarded commands.** The primary records each accepted command, including those from controllers, timecode and flows, in a journal that the backup long-polls on `/api/backup/commands`. The backup replays them in order, so fades and cues run on both computers at the same time.
3. **Live state checkpoints.** About once a second, the backup asks for a checkpoint of the primary's live state on `/api/backup/live-state`. Each crate registers how to capture and restore its own part. A checkpoint carries the sequence of the last forwarded command it reflects, so the backup never applies a checkpoint older than the commands it already replayed, and corrects any drift.

The copied show lives in a `failover` folder in the app data folder, apart from the backup's own showfiles and drafts. Its draft, autosaves and saves stay there while that computer runs it, including after a takeover. Saving it under a new name makes it one of that computer's own showfiles.

### Keep the backup quiet

A backup sends sACN one priority step below the show's priority, so receivers keep following the primary and fall back to the backup on their own if the primary's stream stops. Art-Net and USB DMX are muted on a backup. A backup refuses changes from its own clients. Only role commands, such as take over and leave the pair, and opening a show pass.

A backup sends the copied show only after it takes over. When a backup leaves the pair, or its primary leaves, the backup swaps in an empty world that waits for a show, so its clients return to the welcome screen. Output stays in standby until that world, or a show a client opens instead, replaces the copy.

### Promote the backup

- **Heartbeat.** Every host answers `/api/public/backup/status` with whether it follows a primary, its takeover epoch, its sACN CID and whether a show is open. A backup asks its primary twice a second. Routes under `/api/public/` skip pairing.
- **Automatic takeover.** When the primary has not answered for 3 seconds, the backup takes over, unless the primary's sACN CID still arrives. In that case only the network between the two failed. Automatic takeover is a setting on each backup and is on by default. Manual takeover is always available.
- **Epochs.** Each takeover raises a stored epoch past both hosts' last one. A backup adopts its primary's epoch while it follows.
- **No automatic fail-back.** A primary that comes back after a takeover becomes the backup of the host that took over. It checks its remembered backup on startup before it sends output, and every 2 seconds after. The host that took over also asks its old primary to step down on `/api/public/backup/step-down`, in case the old primary cannot reach it. The old primary obeys only its remembered backup, with the pair key and a newer epoch.

### Pair the two computers

When a backup first follows a primary, it pairs with the primary's PIN. The primary then issues a **pair key** on `/api/backup/pair-key`, and both computers store it with their role. Each accepts the key like a pairing token, so the pair needs no PIN again after a restart, a takeover or **New PIN**. A backup's checkpoint requests must carry the key.

**Leave the pair** on either computer forgets the other and the key:

- A primary that leaves answers its backup's checkpoint requests with `410 Gone`, and the backup leaves too.
- A backup that leaves, or opens a show, tells its primary on `/api/public/backup/leave`, with the key. The primary then forgets it.

A computer that belongs to a pair starts with a **Failover** dialog instead of the show prompt. There it continues as primary, follows its partner, takes over or leaves the pair. **Continue as primary** reopens the pair's show from the `failover` folder when this computer ran it last.

## Consequences

- Receivers fail over to the backup's sACN on their own, within the sACN source timeout, even before the backup takes over. Art-Net and USB DMX resume only once the backup takes over.
- Every forwarded command and checkpoint is extra traffic between the two computers. The journal and the checkpoints stay on the local network.
- Each crate that holds live state must register a capture and a restore, or a takeover loses that state.
- Known limits:
  - The heartbeat shows that the primary's server answers, not that its engine runs. An engine that hangs while the server keeps answering does not trigger a takeover. Checking the engine's frame instead would need a world swap, such as a slow show load, not to read as a failure.
  - A backup that loses its own network cannot tell that apart from the primary failing, and takes over too. When the network returns, the host that took over last keeps the show. Operators who want to decide every takeover can turn automatic takeover off.
  - A device paired with the PIN could ask for the pair key, which **New PIN** does not revoke. **Leave the pair** revokes it. This matches the trust model of pairing, which guards a trusted network against casual use, not a hostile one.
  - The `failover` folder keeps every pair show a computer copied, and never prunes them.
