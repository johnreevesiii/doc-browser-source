// rom-picker.js: the "choose your ROM" UI. Reads a local file the player
// picks and stores it with rom-store.js. GPL-2.0-or-later.
//
// No network code is allowed in this file (test/policy.test.mjs).

import { checkRomName, checkRomSize } from './rom-store.js';

// Pure helper: which of the picked files are acceptable, and why not.
export function triageFiles(files) {
  const accepted = [];
  const rejected = [];
  for (const f of Array.from(files || [])) {
    const why = checkRomName(f.name) || checkRomSize(f.size);
    if (why) rejected.push({ name: f.name, reason: why });
    else accepted.push(f);
  }
  return { accepted, rejected };
}

// Wires an <input type=file>, a list element and a status element.
// onSelect(name) is called when the player picks a stored ROM to boot.
export function mountRomPicker({ input, listEl, statusEl, store, onSelect }) {
  const doc = listEl.ownerDocument;

  function status(msg) {
    statusEl.textContent = msg;
  }

  async function refresh() {
    const roms = await store.list();
    listEl.replaceChildren();
    if (roms.length === 0) {
      const li = doc.createElement('li');
      li.textContent = 'No ROMs stored in this browser yet.';
      listEl.append(li);
      return;
    }
    for (const rom of roms) {
      const li = doc.createElement('li');
      const boot = doc.createElement('button');
      boot.type = 'button';
      boot.textContent = `Boot ${rom.name}`;
      boot.addEventListener('click', () => onSelect(rom.name));
      const del = doc.createElement('button');
      del.type = 'button';
      del.textContent = 'Remove';
      del.addEventListener('click', async () => {
        await store.remove(rom.name);
        status(`Removed ${rom.name} from this browser.`);
        await refresh();
      });
      const size = doc.createElement('span');
      size.textContent = ` ${(rom.size / 1048576).toFixed(1)} MB `;
      li.append(boot, size, del);
      listEl.append(li);
    }
  }

  input.addEventListener('change', async () => {
    const { accepted, rejected } = triageFiles(input.files);
    for (const r of rejected) status(`Skipped ${r.name}: ${r.reason}.`);
    for (const f of accepted) {
      status(`Copying ${f.name} into browser storage...`);
      try {
        await store.save(f);
        status(`Stored ${f.name}. It stays on this device.`);
      } catch (err) {
        status(String(err && err.message ? err.message : err));
      }
    }
    input.value = '';
    await refresh();
  });

  return { refresh };
}
