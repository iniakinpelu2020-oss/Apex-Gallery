# Apex Gallery

A timeline over the photos and videos **Apex Camera** saved on this device. One static folder, no
build step, no dependencies, and every path relative (`./`) so the same files work on their own,
installed as a PWA, or mounted by ApexOS at `/apps/gallery/`.

Gallery has **no storage of its own**. It opens the database Camera writes, lists what is in it, and
never writes anything except a delete you explicitly confirm.

```
index.html      header, filters, grid, viewer dialog
styles.css      dark grid, sticky header, touch-first viewer
app.js          IndexedDB reads, lazy thumbnails, viewer, delete/download
manifest.json   relative start_url and scope, standalone display
sw.js           offline shell, scoped to this folder
icons/          192, 512 and maskable 512
```

## The shared database

Camera declares the contract and Gallery reads it as-is:

```
IndexedDB   apex-gallery   version 1
store       photos         keyPath 'id'
indexes     createdAt      kind
record      {
              id:        string   (uuid)
              kind:      'photo' | 'video'
              name:      string   ('apex-camera-20261118-150412.jpg')
              type:      string   ('image/jpeg' | 'video/webm')
              size:      number   bytes
              width:     number
              height:    number
              duration:  number   seconds, 0 for photos
              createdAt: string   ISO timestamp
              source:    'apex-camera'
              blob:      Blob     the file itself
            }
```

Gallery opens with the same version and creates an identical store **only if it does not exist**, so
it works when it is the first of the two apps to run. Everything is read from the `photos` cursor;
the blobs stay in the database until a tile scrolls close enough to need one.

## What it does

- **Grid** of square tiles, newest first, with the header counting photos, videos and the total bytes
  held on the device.
- **Lazy thumbnails**: an `IntersectionObserver` asks for a tile's blob only when it is near the
  viewport, then holds the object URL until the page goes away. Video tiles show a film mark and their
  running time instead of decoding a frame.
- **Filters and search**: All / Photos / Videos, plus a case-insensitive name search.
- **Viewer**: `dialog` with the full image or a `controls` video player, the capture date, dimensions,
  size and duration. Arrow keys and swipe move between captures; Escape or a backdrop click closes.
- **Download** saves the blob under its original name. **Delete** removes the record from the shared
  store after a confirm — the only write this app ever makes.
- **Refresh** re-reads the store, and the app also refreshes itself when the tab becomes visible again,
  so a photo taken in Camera in another tab shows up on return.

## Offline

The shell is precached by `sw.js` (`apex-gallery-v1`). Captures never touch the network at all: they
are `Blob`s inside IndexedDB, so the gallery is fully usable with the connection off. Bump `CACHE` in
`sw.js` when shell files change.

## Running it

```bash
python3 -m http.server 8080
# then open http://127.0.0.1:8080/
```

Take a photo in `/apps/camera/` (or `../camera/` in the bundle) and it appears here. Service workers
need `localhost` or https.

## Bundling into ApexOS

Roster entry `Apex-Gallery gallery`. The "Open Apex Camera" button links to `../camera/`, which
resolves to `/apps/camera/` inside the bundle.

## State of this repo

Written against Camera's schema as declared in its `app.js`. Not verified in a browser yet: creating
the store from an empty profile, thumbnails appearing as tiles scroll, the viewer opening photos and
videos, delete removing a record, and one full reload with the network off.
