/* Apex Gallery - an on-device timeline over the captures Apex Camera saved.
 *
 * There is no storage of its own. It reads the shared database that
 * Apex Camera writes:
 *
 *   database  apex-gallery   version 1
 *   store     photos         keyPath 'id'   indexes 'createdAt', 'kind'
 *   record    { id, kind: 'photo' | 'video', name, type, size, width, height,
 *               duration, createdAt, source, blob }
 *
 * The store is created on first open with exactly that shape, so the gallery
 * also works when it is the first of the two apps to run. Nothing is ever
 * written to it except a delete the user asks for.
 */
(function () {
  'use strict';

  var DB_NAME = 'apex-gallery';
  var DB_VERSION = 1;
  var STORE = 'photos';
  var VIDEO_GLYPH = '\u25B6';

  var el = {
    countStamp: document.getElementById('countStamp'),
    searchInput: document.getElementById('searchInput'),
    refreshBtn: document.getElementById('refreshBtn'),
    filterAll: document.getElementById('filterAll'),
    filterPhoto: document.getElementById('filterPhoto'),
    filterVideo: document.getElementById('filterVideo'),
    unsupported: document.getElementById('unsupported'),
    empty: document.getElementById('empty'),
    emptyNote: document.getElementById('emptyNote'),
    grid: document.getElementById('grid'),
    lightbox: document.getElementById('lightbox'),
    lightboxName: document.getElementById('lightboxName'),
    lightboxMeta: document.getElementById('lightboxMeta'),
    lightboxMedia: document.getElementById('lightboxMedia'),
    prevBtn: document.getElementById('prevBtn'),
    nextBtn: document.getElementById('nextBtn'),
    closeBtn: document.getElementById('closeBtn'),
    downloadBtn: document.getElementById('downloadBtn'),
    deleteBtn: document.getElementById('deleteBtn'),
    toast: document.getElementById('toast')
  };

  var items = [];        // metadata, newest first
  var view = [];         // what the grid is showing
  var filter = 'all';
  var query = '';
  var urls = {};         // id -> object URL
  var openIndex = -1;
  var dbPromise = null;
  var observer = null;
  var renderToken = 0;

  /* ---------- database ---------- */

  function openDB() {
    if (!('indexedDB' in window)) return Promise.reject(new Error('no-indexeddb'));
    if (dbPromise) return dbPromise;

    dbPromise = new Promise(function (resolve, reject) {
      var request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onupgradeneeded = function () {
        var database = request.result;
        if (!database.objectStoreNames.contains(STORE)) {
          var store = database.createObjectStore(STORE, { keyPath: 'id' });
          store.createIndex('createdAt', 'createdAt', { unique: false });
          store.createIndex('kind', 'kind', { unique: false });
        }
      };

      request.onsuccess = function () {
        var database = request.result;
        database.onversionchange = function () {
          database.close();
          dbPromise = null;
        };
        resolve(database);
      };

      request.onerror = function () { reject(request.error || new Error('open-failed')); };
      request.onblocked = function () { reject(new Error('blocked')); };
    });

    dbPromise.catch(function () { dbPromise = null; });
    return dbPromise;
  }

  /* Metadata only - the blobs stay in the database until a tile asks for one. */
  function readIndex() {
    return openDB().then(function (database) {
      return new Promise(function (resolve, reject) {
        var out = [];
        var tx = database.transaction(STORE, 'readonly');
        var request = tx.objectStore(STORE).openCursor();

        request.onsuccess = function () {
          var cursor = request.result;
          if (!cursor) return;
          var r = cursor.value || {};
          if (r && r.id !== undefined && r.id !== null) {
            out.push({
              id: String(r.id),
              kind: r.kind === 'video' ? 'video' : 'photo',
              name: typeof r.name === 'string' && r.name ? r.name : 'Untitled capture',
              type: typeof r.type === 'string' ? r.type : '',
              size: Number(r.size) || 0,
              width: Number(r.width) || 0,
              height: Number(r.height) || 0,
              duration: Number(r.duration) || 0,
              createdAt: typeof r.createdAt === 'string' ? r.createdAt : '',
              source: typeof r.source === 'string' ? r.source : ''
            });
          }
          cursor.continue();
        };

        tx.oncomplete = function () { resolve(out); };
        tx.onerror = function () { reject(tx.error || new Error('read-failed')); };
      });
    }).then(function (list) {
      list.forEach(function (r) {
        var stamp = Date.parse(r.createdAt);
        r.stamp = isFinite(stamp) ? stamp : 0;
      });
      list.sort(function (a, b) {
        if (a.stamp !== b.stamp) return b.stamp - a.stamp;
        return a.name < b.name ? 1 : -1;
      });
      return list;
    });
  }

  function getRecord(id) {
    return openDB().then(function (database) {
      return new Promise(function (resolve, reject) {
        var tx = database.transaction(STORE, 'readonly');
        var request = tx.objectStore(STORE).get(id);
        request.onsuccess = function () { resolve(request.result || null); };
        request.onerror = function () { reject(request.error || new Error('get-failed')); };
      });
    });
  }

  function removeRecord(id) {
    return openDB().then(function (database) {
      return new Promise(function (resolve, reject) {
        var tx = database.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).delete(id);
        tx.oncomplete = function () { resolve(); };
        tx.onerror = function () { reject(tx.error || new Error('delete-failed')); };
        tx.onabort = function () { reject(tx.error || new Error('delete-aborted')); };
      });
    });
  }

  function urlFor(item) {
    if (urls[item.id]) return Promise.resolve(urls[item.id]);
    return getRecord(item.id).then(function (record) {
      if (!record || !record.blob) throw new Error('missing-blob');
      if (!urls[item.id]) urls[item.id] = URL.createObjectURL(record.blob);
      return urls[item.id];
    });
  }

  function dropUrl(id) {
    if (!urls[id]) return;
    URL.revokeObjectURL(urls[id]);
    delete urls[id];
  }

  /* ---------- helpers ---------- */

  function toast(msg) {
    el.toast.textContent = msg;
    el.toast.hidden = false;
    clearTimeout(toast.timer);
    toast.timer = setTimeout(function () { el.toast.hidden = true; }, 3000);
  }

  function bytes(n) {
    if (!n) return '0 B';
    var units = ['B', 'KB', 'MB', 'GB'];
    var i = 0;
    var v = n;
    while (v >= 1024 && i < units.length - 1) { v = v / 1024; i += 1; }
    return (v >= 10 || i === 0 ? Math.round(v) : v.toFixed(1)) + ' ' + units[i];
  }

  function when(iso, stamp) {
    var d = new Date(stamp || Date.parse(iso));
    if (isNaN(d.getTime())) return 'Undated';
    return d.toLocaleString([], {
      day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit'
    });
  }

  function clock(seconds) {
    var total = Math.max(0, Math.round(seconds || 0));
    var m = Math.floor(total / 60);
    var s = total % 60;
    return m + ':' + (s < 10 ? '0' : '') + s;
  }

  function match(item) {
    if (filter !== 'all' && item.kind !== filter) return false;
    if (!query) return true;
    return item.name.toLowerCase().indexOf(query) !== -1;
  }

  function paintStamp() {
    var photos = 0;
    var videos = 0;
    var size = 0;
    items.forEach(function (it) {
      if (it.kind === 'video') videos += 1; else photos += 1;
      size += it.size;
    });

    if (!items.length) {
      el.countStamp.textContent = 'No captures on this device yet';
      return;
    }

    var parts = [];
    parts.push(photos + (photos === 1 ? ' photo' : ' photos'));
    parts.push(videos + (videos === 1 ? ' video' : ' videos'));
    parts.push(bytes(size) + ' on this device');
    el.countStamp.textContent = parts.join(' \u00B7 ');
  }

  /* ---------- grid ---------- */

  function observeThumb(img, item) {
    if (!('IntersectionObserver' in window)) {
      loadThumb(img, item);
      return;
    }
    if (!observer) {
      observer = new IntersectionObserver(function (entries) {
        entries.forEach(function (entry) {
          if (!entry.isIntersecting) return;
          observer.unobserve(entry.target);
          loadThumb(entry.target, entry.target.apexItem);
        });
      }, { rootMargin: '320px 0px' });
    }
    img.apexItem = item;
    observer.observe(img);
  }

  function loadThumb(img, item) {
    urlFor(item).then(function (url) {
      img.addEventListener('load', function () { img.classList.add('loaded'); });
      img.src = url;
    }).catch(function () {
      img.alt = 'Preview unavailable';
    });
  }

  function tile(item, index) {
    var li = document.createElement('li');
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'tile';
    btn.setAttribute('aria-label', item.name + (item.kind === 'video' ? ', video' : ', photo'));
    btn.addEventListener('click', function () { openViewer(index); });

    if (item.kind === 'photo') {
      var img = document.createElement('img');
      img.alt = '';
      img.decoding = 'async';
      btn.appendChild(img);
      var holder = document.createElement('span');
      holder.className = 'placeholder';
      holder.textContent = '\u25A1';
      btn.appendChild(holder);
      img.addEventListener('load', function () { holder.remove(); });
      observeThumb(img, item);
    } else {
      var film = document.createElement('span');
      film.className = 'placeholder';
      film.textContent = VIDEO_GLYPH;
      btn.appendChild(film);
      var tag = document.createElement('span');
      tag.className = 'kind';
      tag.textContent = 'Video';
      btn.appendChild(tag);
      if (item.duration) {
        var badge = document.createElement('span');
        badge.className = 'badge';
        badge.textContent = clock(item.duration);
        btn.appendChild(badge);
      }
    }

    li.appendChild(btn);
    return li;
  }

  function render() {
    paintStamp();

    var token = ++renderToken;
    view = items.filter(match);

    el.grid.textContent = '';
    var frag = document.createDocumentFragment();
    view.forEach(function (item, index) { frag.appendChild(tile(item, index)); });
    el.grid.appendChild(frag);

    el.empty.hidden = view.length !== 0;
    if (!view.length) {
      el.emptyNote.textContent = items.length
        ? 'No captures match this filter. Clear the search or switch back to All.'
        : 'Photos and videos you take in Apex Camera are kept on this device and show up in this grid.';
    }

    if (token !== renderToken) return;
  }

  /* ---------- viewer ---------- */

  function openViewer(index) {
    if (index < 0 || index >= view.length) return;
    openIndex = index;
    var item = view[index];

    el.lightboxName.textContent = item.name;

    var bits = [when(item.createdAt, item.stamp)];
    if (item.width && item.height) bits.push(item.width + ' \u00D7 ' + item.height);
    bits.push(item.kind === 'video' ? clock(item.duration) : bytes(item.size));
    if (item.kind === 'video') bits.push(bytes(item.size));
    el.lightboxMeta.textContent = bits.join(' \u00B7 ');

    el.lightboxMedia.textContent = '';
    var placeholder = document.createElement('p');
    placeholder.className = 'missing';
    placeholder.textContent = 'Loading\u2026';
    el.lightboxMedia.appendChild(placeholder);

    el.prevBtn.disabled = view.length < 2;
    el.nextBtn.disabled = view.length < 2;

    urlFor(item).then(function (url) {
      if (openIndex !== index) return;
      el.lightboxMedia.textContent = '';

      if (item.kind === 'video') {
        var video = document.createElement('video');
        video.controls = true;
        video.playsInline = true;
        video.preload = 'metadata';
        video.src = url;
        el.lightboxMedia.appendChild(video);
      } else {
        var img = document.createElement('img');
        img.alt = item.name;
        img.src = url;
        el.lightboxMedia.appendChild(img);
      }

      el.downloadBtn.href = url;
      el.downloadBtn.setAttribute('download', item.name);
    }).catch(function () {
      el.lightboxMedia.textContent = '';
      var gone = document.createElement('p');
      gone.className = 'missing';
      gone.textContent = 'That file is no longer in device storage. Press Refresh to update the grid.';
      el.lightboxMedia.appendChild(gone);
      el.downloadBtn.removeAttribute('href');
    });

    if (!el.lightbox.open) {
      if (typeof el.lightbox.showModal === 'function') el.lightbox.showModal();
      else el.lightbox.setAttribute('open', '');
    }
  }

  function closeViewer() {
    openIndex = -1;
    el.lightboxMedia.textContent = '';
    if (el.lightbox.open) el.lightbox.close();
    else el.lightbox.removeAttribute('open');
  }

  function step(delta) {
    if (openIndex < 0 || view.length < 2) return;
    var next = (openIndex + delta + view.length) % view.length;
    openViewer(next);
  }

  /* ---------- loading ---------- */

  function refresh(quiet) {
    el.refreshBtn.disabled = true;
    return readIndex().then(function (list) {
      items = list;
      el.unsupported.hidden = true;
      render();
      el.refreshBtn.disabled = false;
      if (!quiet) {
        toast(list.length
          ? list.length + (list.length === 1 ? ' capture' : ' captures') + ' on this device'
          : 'No captures on this device yet');
      }
    }).catch(function (err) {
      el.refreshBtn.disabled = false;
      var reason = err && err.message ? err.message : '';
      if (reason === 'no-indexeddb' || reason === 'open-failed') {
        el.unsupported.hidden = false;
        el.empty.hidden = true;
        el.grid.textContent = '';
        el.countStamp.textContent = 'Device storage is unavailable';
        return;
      }
      el.countStamp.textContent = 'Could not read device storage';
      if (!quiet) toast('Could not read device storage \u2014 press Refresh to retry');
    });
  }

  function setFilter(next) {
    filter = next;
    el.filterAll.setAttribute('aria-pressed', next === 'all' ? 'true' : 'false');
    el.filterPhoto.setAttribute('aria-pressed', next === 'photo' ? 'true' : 'false');
    el.filterVideo.setAttribute('aria-pressed', next === 'video' ? 'true' : 'false');
    render();
  }

  /* ---------- wiring ---------- */

  el.filterAll.addEventListener('click', function () { setFilter('all'); });
  el.filterPhoto.addEventListener('click', function () { setFilter('photo'); });
  el.filterVideo.addEventListener('click', function () { setFilter('video'); });

  el.searchInput.addEventListener('input', function () {
    query = el.searchInput.value.trim().toLowerCase();
    render();
  });

  el.refreshBtn.addEventListener('click', function () { refresh(false); });

  el.closeBtn.addEventListener('click', closeViewer);

  el.lightbox.addEventListener('cancel', function (event) {
    event.preventDefault();
    closeViewer();
  });

  el.lightbox.addEventListener('click', function (event) {
    if (event.target === el.lightbox) closeViewer();
  });

  el.prevBtn.addEventListener('click', function () { step(-1); });
  el.nextBtn.addEventListener('click', function () { step(1); });

  document.addEventListener('keydown', function (event) {
    if (!el.lightbox.open && !el.lightbox.hasAttribute('open')) return;
    if (event.key === 'ArrowLeft') { event.preventDefault(); step(-1); }
    if (event.key === 'ArrowRight') { event.preventDefault(); step(1); }
  });

  var swipeFrom = null;
  el.lightboxMedia.addEventListener('pointerdown', function (event) {
    swipeFrom = { x: event.clientX, y: event.clientY };
  });
  el.lightboxMedia.addEventListener('pointerup', function (event) {
    if (!swipeFrom) return;
    var dx = event.clientX - swipeFrom.x;
    var dy = event.clientY - swipeFrom.y;
    swipeFrom = null;
    if (Math.abs(dx) > 48 && Math.abs(dx) > Math.abs(dy) * 1.6) step(dx < 0 ? 1 : -1);
  });

  el.deleteBtn.addEventListener('click', function () {
    var item = openIndex >= 0 ? view[openIndex] : null;
    if (!item) return;
    if (!window.confirm('Delete "' + item.name + '" from this device? This cannot be undone.')) return;

    el.deleteBtn.disabled = true;
    removeRecord(item.id).then(function () {
      el.deleteBtn.disabled = false;
      dropUrl(item.id);
      items = items.filter(function (it) { return it.id !== item.id; });
      closeViewer();
      render();
      toast('Deleted ' + item.name);
    }).catch(function () {
      el.deleteBtn.disabled = false;
      toast('Could not delete that file');
    });
  });

  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible') refresh(true);
  });

  window.addEventListener('pagehide', function () {
    Object.keys(urls).forEach(dropUrl);
  });

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('./sw.js').catch(function () {});
    });
  }

  refresh(true);
})();
