// An accessible combobox (WAI-ARIA 1.2 pattern) over an async suggestion source.
// The source is swappable so the same input works with Google and with OpenStreetMap.

let uid = 0;

/**
 * @param {HTMLInputElement} input
 * @param {HTMLUListElement} list
 * @param {object} opts
 * @param {(query: string, signal: AbortSignal) => Promise<Array<{title: string, subtitle?: string}>>} opts.fetchSuggestions
 * @param {(suggestion: object) => void} opts.onSelect
 * @param {() => void} [opts.onEdit]  called when the user types (the old selection is stale)
 * @param {() => string} [opts.footer]  small text shown under the suggestions (e.g. attribution)
 */
export function attachAutocomplete(input, list, { fetchSuggestions, onSelect, onEdit, footer, minChars = 2, debounceMs = 250 }) {
  const prefix = `ac${++uid}`;
  let items = [];
  let active = -1;
  let timer = 0;
  let controller = null;

  function close() {
    list.hidden = true;
    list.replaceChildren();
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
    items = [];
    active = -1;
  }

  function setActive(index) {
    const options = list.querySelectorAll('[role="option"]');
    options.forEach((el, i) => el.setAttribute('aria-selected', String(i === index)));
    active = index;
    if (index >= 0 && options[index]) {
      input.setAttribute('aria-activedescendant', options[index].id);
      options[index].scrollIntoView({ block: 'nearest' });
    } else {
      input.removeAttribute('aria-activedescendant');
    }
  }

  function choose(index) {
    const item = items[index];
    if (!item) return;
    input.value = item.title;
    close();
    onSelect(item);
  }

  function render(suggestions, { emptyText = 'לא נמצאו מקומות בשם הזה' } = {}) {
    items = suggestions;
    active = -1;
    const nodes = suggestions.map((s, i) => {
      const li = document.createElement('li');
      li.id = `${prefix}-opt-${i}`;
      li.setAttribute('role', 'option');
      li.setAttribute('aria-selected', 'false');
      const title = document.createElement('span');
      title.className = 's-title';
      title.textContent = s.title;
      li.append(title);
      if (s.subtitle) {
        const sub = document.createElement('span');
        sub.className = 's-sub';
        sub.textContent = s.subtitle;
        li.append(sub);
      }
      // pointerdown fires before the input's blur, so the list is still there.
      li.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        choose(i);
      });
      return li;
    });
    if (nodes.length === 0) {
      const li = document.createElement('li');
      li.className = 's-empty';
      li.textContent = emptyText;
      nodes.push(li);
    }
    const note = footer?.();
    if (note && suggestions.length) {
      const li = document.createElement('li');
      li.className = 's-powered';
      li.setAttribute('aria-hidden', 'true');
      li.textContent = note;
      nodes.push(li);
    }
    list.replaceChildren(...nodes);
    list.hidden = false;
    input.setAttribute('aria-expanded', 'true');
  }

  async function update() {
    const query = input.value.trim();
    controller?.abort();
    if (query.length < minChars) {
      close();
      return;
    }
    controller = new AbortController();
    const { signal } = controller;
    try {
      const suggestions = await fetchSuggestions(query, signal);
      if (signal.aborted || document.activeElement !== input) return;
      render(suggestions);
    } catch (err) {
      if (signal.aborted || err?.name === 'AbortError') return;
      console.warn('autocomplete failed', err);
      if (document.activeElement === input) render([], { emptyText: 'אין כרגע הצעות. אפשר להמשיך להקליד ולחפש.' });
    }
  }

  input.addEventListener('input', () => {
    onEdit?.();
    clearTimeout(timer);
    timer = setTimeout(update, debounceMs);
  });

  input.addEventListener('keydown', (e) => {
    const open = !list.hidden && items.length > 0;
    if (e.key === 'ArrowDown') {
      if (!open) return;
      e.preventDefault();
      setActive((active + 1) % items.length);
    } else if (e.key === 'ArrowUp') {
      if (!open) return;
      e.preventDefault();
      setActive(active <= 0 ? items.length - 1 : active - 1);
    } else if (e.key === 'Enter') {
      if (open && active >= 0) {
        e.preventDefault();
        choose(active);
      } else {
        close();
      }
    } else if (e.key === 'Escape') {
      if (!list.hidden) {
        e.preventDefault();
        close();
      }
    }
  });

  input.addEventListener('blur', () => {
    clearTimeout(timer);
    controller?.abort();
    close();
  });

  return {
    close,
    /** Cancel any pending lookup (e.g. when the value is set programmatically). */
    cancel() {
      clearTimeout(timer);
      controller?.abort();
      close();
    },
  };
}
