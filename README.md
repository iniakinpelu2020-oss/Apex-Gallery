# Apex Gallery

A private photo and video view over the files `Apex-Drive` has already uploaded.

**Status: not built. It should not have storage of its own.**

## The design decision

Your plan lists Supabase Storage plus Syncthing. Both are wrong here, and it is worth
saying why plainly.

- **Supabase Storage free is 1 GB with a 50 MB per-file cap.** One phone album is bigger.
- **Syncthing needs a peer that is online.** A phone cannot sync to a laptop that is off,
  and Syncthing on Android is battery-hungry and awkward with scoped storage.
- **`Apex-Drive` already stores the same files** in the B2 bucket, with a checksum to prove
  it. A second copy doubles the problem and halves the free space.

So Gallery is a **viewer and a timeline over the drive's manifest** (`GET /api/drive/list`),
plus thumbnails. One copy of every file, one quota, one place to lose it.

## What it needs from the drive

- A thumbnail endpoint, or thumbnails generated on upload and stored beside the original.
- Range requests, already supported by the storage layer, so video can stream.
- Signed, short-lived download URLs so the bucket stays private.

## What you need to do

1. Nothing until the drive is deployed and has files in it.

## First three steps

1. A grid view over `/api/drive/list`, filtered to images.
2. Thumbnails, generated on the phone before upload (cheap, and it keeps the bucket small).
3. Video playback using ranged reads.
