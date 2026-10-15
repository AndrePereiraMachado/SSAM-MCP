// Compile once per credential-set version. Terminal failure links avoid copying
// every suffix output, so nested credentials cannot expand scan data.
export function createCredentialMatcher(values) {
  const patterns = [...new Set(values.filter(value => typeof value === 'string' && value.length >= 16)
    .flatMap(value => {
      try { return [value, encodeURIComponent(value)]; } catch { return [value]; }
    }))].sort((a, b) => b.length - a.length);
  const terminals = new Array(patterns.length);
  const nodes = [{ next: new Map(), fail: 0, rank: -1, terminal: 0, parent: 0, jump: [], depth: 0 }];
  for (let rank = 0; rank < patterns.length; rank++) {
    let state = 0;
    for (const char of patterns[rank]) {
      let next = nodes[state].next.get(char);
      if (next === undefined) {
        next = nodes.length; nodes[state].next.set(char, next);
        nodes.push({ next: new Map(), fail: 0, rank: -1, terminal: 0, parent: 0, jump: [], depth: nodes[state].depth + char.length });
      }
      state = next;
    }
    nodes[state].rank = rank; terminals[rank] = state;
  }
  const queue = [...nodes[0].next.values()];
  for (let index = 0; index < queue.length; index++) {
    const state = queue[index], node = nodes[state];
    node.parent = nodes[node.fail].terminal;
    node.terminal = node.rank >= 0 ? state : node.parent;
    if (node.rank >= 0) {
      node.jump = [node.parent];
      for (let k = 1; node.jump[k - 1]; k++) node.jump[k] = nodes[node.jump[k - 1]].jump[k - 1] ?? 0;
    }
    for (const [char, child] of node.next) {
      queue.push(child); let failure = node.fail;
      while (failure && !nodes[failure].next.has(char)) failure = nodes[failure].fail;
      nodes[child].fail = nodes[failure].next.get(char) ?? 0;
    }
  }
  function scan(text, emit) {
    let state = 0, offset = 0;
    for (const char of text) {
      offset += char.length;
      while (state && !nodes[state].next.has(char)) state = nodes[state].fail;
      state = nodes[state].next.get(char) ?? 0;
      if (emit && nodes[state].terminal) emit(nodes[state].terminal, offset);
    }
    return state;
  }
  function terminalWithin(terminal, length) {
    if (nodes[terminal].depth <= length) return terminal;
    for (let k = nodes[terminal].jump.length - 1; k >= 0; k--) {
      const ancestor = nodes[terminal].jump[k];
      if (ancestor && nodes[ancestor].depth > length) terminal = ancestor;
    }
    return nodes[terminal].parent;
  }
  return {
    replace(text) {
      if (!patterns.length || text.length < 16) return text;
      // Allocate only for patterns that actually match this string. A sparse
      // rank heap also avoids visiting every registered value for a lone echo.
      const buckets = new Map(), ranks = [];
      function enqueue(rank, end) {
        let ends = buckets.get(rank);
        if (!ends) {
          ends = []; buckets.set(rank, ends);
          let index = ranks.length; ranks.push(rank);
          while (index) {
            const parent = (index - 1) >>> 1;
            if (ranks[parent] <= rank) break;
            ranks[index] = ranks[parent]; index = parent;
          }
          ranks[index] = rank;
        }
        ends.push(end);
      }
      function nextRank() {
        const first = ranks[0], last = ranks.pop();
        if (ranks.length) {
          let index = 0;
          while (index * 2 + 1 < ranks.length) {
            let child = index * 2 + 1;
            if (child + 1 < ranks.length && ranks[child + 1] < ranks[child]) child++;
            if (ranks[child] >= last) break;
            ranks[index] = ranks[child]; index = child;
          }
          ranks[index] = last;
        }
        return first;
      }
      scan(text, (terminal, end) => enqueue(nodes[terminal].rank, end));
      if (!ranks.length) return text;
      // One candidate per position. Rejected overlaps lazily select a shorter
      // terminal fitting the free suffix, preserving global longest priority.
      const words = new Uint32Array(Math.ceil(text.length / 32));
      let base = 1; while (base < words.length) base *= 2;
      const present = new Uint8Array(base * 2);
      function lastOccupied(end) {
        const word = end >>> 5, bit = end & 31;
        const masked = words[word] & (bit === 31 ? 0xffffffff : (2 ** (bit + 1) - 1));
        if (masked) return word * 32 + 31 - Math.clz32(masked);
        let index = base + word;
        while (index > 1) {
          if ((index & 1) && present[index - 1]) {
            index--;
            while (index < base) index = present[index * 2 + 1] ? index * 2 + 1 : index * 2;
            const earlier = index - base;
            return earlier * 32 + 31 - Math.clz32(words[earlier]);
          }
          index >>>= 1;
        }
        return -1;
      }
      function occupy(start, end) {
        for (let word = start >>> 5; word <= (end - 1) >>> 5; word++) {
          const low = word === start >>> 5 ? start & 31 : 0;
          const high = word === (end - 1) >>> 5 ? (end - 1) & 31 : 31;
          words[word] |= (high === 31 ? 0xffffffff : 2 ** (high + 1) - 1) & ~((2 ** low) - 1);
          let index = base + word;
          while (index && !present[index]) { present[index] = 1; index >>>= 1; }
        }
      }
      const selected = [];
      while (ranks.length) {
        const rank = nextRank(), ends = buckets.get(rank);
        buckets.delete(rank); ends.sort((a, b) => a - b);
        for (const end of ends) {
          const start = end - patterns[rank].length, occupied = lastOccupied(end - 1);
          if (occupied >= start) {
            const free = end - occupied - 1;
            if (free >= 16) {
              const shorter = terminalWithin(terminals[rank], free);
              if (shorter) enqueue(nodes[shorter].rank, end);
            }
            continue;
          }
          occupy(start, end); selected.push({ start, end });
        }
      }
      selected.sort((a, b) => a.start - b.start);
      const pieces = []; let end = 0;
      for (const match of selected) { pieces.push(text.slice(end, match.start), '[REDACTED]'); end = match.end; }
      pieces.push(text.slice(end)); return pieces.join('');
    },
    trimPrefix(text) {
      if (!patterns.length || text.length < 8) return text;
      let state = scan(text);
      while (state && nodes[state].rank >= 0) state = nodes[state].fail;
      return nodes[state].depth >= 8 ? text.slice(0, -nodes[state].depth) + '[REDACTED]' : text;
    },
  };
}
