// incr-scope/incr.js — node-centric cursor-движок (переписан с нуля под модель).
//
//   • единица состояния — DOM-узел; инстанс scope создаётся ДО fn и после fn
//     приклеивается к узлу (node._scope);
//   • memo(fn) -> (cs, ...rest): ровно ОДИН корневой DOM-узел (элемент/текст).
//     Multi-root / null запрещены; существованием управляет родитель;
//   • ключ = ID ?? CS (window.ID — явный ключ, сбрасывается после взятия);
//   • курсор — узел; counter считает СОЗДАННЫЕ ноды на текущем уровне: вход в
//     элемент/компонент save→0, выход restore+1. Отсюда 1-нодная проверка memo;
//   • depth — вложенность КОМПОНЕНТОВ (только порядок эффектов);
//   • трекинг чтений: scope.deps + обратная dependencyMap, запись кладёт в batch;
//   • batch разбирается по depth (родитель раньше); эффект гоняет sc.cb у sc.node;
//   • дропы per-pass: dropped = Map<key, node|node[]>; deps снимаются при очистке
//     реестра (узел может переехать — канбан).
//
// API: data, tags, end, text, css, memo, mount.
(() => {
  // ================= globals =================
  let cursor = null       // текущий узел
  let parent = null       // текущий родитель
  let counter = 0         // создано нод на текущем уровне
  let depth = 0           // вложенность компонентов
  let tracking = null     // куда пишет track
  let dropped = null      // Map<key, node|node[]>
  let batch = new Set()
  let activeList = null   // список текущего прохода (swap-механика)
  const stack = []        // открытые контейнеры (для end())
  const TEXT = Symbol('text')
  window.ID = null        // явный ключ: юзер ставит ID перед вызовом, движок забирает
  const takeKey = (cs) => { const id = ID; if (id == null) return cs; ID = null; return id }

  // ================= dropped =================
  const dropNode = (k, n) => {
    n.remove()
    if (!dropped) dropped = new Map()
    const c = dropped.get(k)
    if (c === undefined) dropped.set(k, n)
    else if (Array.isArray(c)) c.push(n)
    else dropped.set(k, [c, n])
  }
  const takeDropped = (k) => {
    if (!dropped) return null
    const c = dropped.get(k)
    if (c === undefined) return null
    if (Array.isArray(c)) { const n = c.pop(); if (!c.length) dropped.delete(k); return n }
    dropped.delete(k); return c
  }
  const removeFromDropped = (n) => {
    const k = n._key
    if (k == null || !dropped) return
    const c = dropped.get(k)
    if (c === n) dropped.delete(k)
    else if (Array.isArray(c)) { const i = c.indexOf(n); if (i >= 0) c.splice(i, 1); if (!c.length) dropped.delete(k) }
  }
  // TODO(onCleanup): вернуть публичный onCleanup(fn) — колбэк при дропе/снятии scope.
  const clearDropped = () => {
    if (!dropped) return
    const kill = (n) => {
      if (n._scope) { clearDeps(n._scope); n._scope = undefined }
      for (let c = n.firstChild; c; c = c.nextSibling) kill(c)
    }
    for (const v of dropped.values()) Array.isArray(v) ? v.forEach(kill) : kill(v)
    dropped = null
  }

  // ================= реактивность (эффект-система копируется с хаками массивов) =================
  const DATA = Symbol('data'), RAW = Symbol('raw'), UID = Symbol('uid'), ITER = Symbol('iter'), ARR = Symbol('arr')
  const proxyCache = new WeakMap(), uidMap = new WeakMap()
  let uidSeq = 0
  const dependencyMap = new WeakMap()

  const track = (t, k) => {
    const sc = tracking
    if (!sc) return
    if (typeof k === 'symbol' && k !== ITER) return
    // ВАЖНО: маппинг индексов в ARR — строго ПОСЛЕ проверки символов (AGENTS).
    if (Array.isArray(t) && typeof k !== 'symbol') k = ARR
    let m = dependencyMap.get(t)
    if (!m) dependencyMap.set(t, m = new Map())
    let s = m.get(k)
    if (!s) m.set(k, s = new Set())
    if (!s.has(sc)) { s.add(sc); sc.deps.add(s) }
  }
  const trigger = (t, k) => {
    if (Array.isArray(t) && typeof k !== 'symbol') k = ARR
    const s = dependencyMap.get(t)?.get(k)
    if (!s || !s.size) return
    let any = false
    for (const sc of s) { if (sc === tracking) continue; batch.add(sc); any = true }
    if (any) schedule()
  }
  const clearDeps = (sc) => { for (const s of sc.deps) s.delete(sc); sc.deps.clear() }

  const plainProto = (v) => { const p = Object.getPrototypeOf(v); return p === Object.prototype || p === null }
  const proxiable = (v) => Array.isArray(v) || plainProto(v)
  const isProps = (x) => x != null && x.constructor === Object

  const arrayInstrumentations = Object.create(null)
  for (const m of ['push', 'pop', 'shift', 'unshift', 'splice', 'sort', 'reverse']) {
    const orig = Array.prototype[m]
    arrayInstrumentations[m] = function (...a) {
      const t = this[RAW], n0 = t.length
      for (let i = 0; i < a.length; i++) if (a[i] && a[i][DATA]) a[i] = a[i][RAW]
      const r = orig.apply(t, a)
      trigger(t, ARR); if (t.length !== n0) trigger(t, 'length'); trigger(t, ITER)
      return r
    }
  }
  const objGet = (t, k) => {
    if (k === DATA) return true
    if (k === RAW) return t
    if (k === UID) return uidMap.get(t)
    if (typeof k === 'symbol') return t[k]
    track(t, k)
    const v = t[k]
    if (v && typeof v === 'object' && !(v instanceof Node) && proxiable(v)) return v[DATA] ? v : proxify(v)
    return v
  }
  const arrGet = (t, k) => arrayInstrumentations[k] || objGet(t, k)
  const proxify = (target) => {
    let p = proxyCache.get(target)
    if (p) return p
    uidMap.set(target, ++uidSeq)
    p = new Proxy(target, {
      get: Array.isArray(target) ? arrGet : objGet,
      has(t, k) { track(t, k); return Reflect.has(t, k) },
      ownKeys(t) { track(t, ITER); return Reflect.ownKeys(t) }, // Object.keys / for..in
      set(t, k, v) {
        if (v && typeof v === 'object' && v[DATA]) v = v[RAW] // не копить proxy-в-proxy
        const had = Object.prototype.hasOwnProperty.call(t, k), old = t[k]
        const isArr = Array.isArray(t), oldLen = isArr ? t.length : 0
        t[k] = v
        if (old !== v) trigger(t, k)
        if (!had) trigger(t, ITER)
        if (isArr && k !== 'length' && t.length !== oldLen) trigger(t, 'length')
        return true
      },
      deleteProperty(t, k) {
        const had = Object.prototype.hasOwnProperty.call(t, k)
        delete t[k]
        if (had) { trigger(t, k); trigger(t, ITER) }
        if (Array.isArray(t)) trigger(t, 'length')
        return true
      },
    })
    proxyCache.set(target, p)
    return p
  }
  const data = (init) => proxify(Array.isArray(init) ? [...init] : { ...init })

  // ================= эффекты =================
  let scheduled = false, flushing = false
  const MAX_PASSES = 100
  const schedule = () => { if (scheduled || flushing) return; scheduled = true; queueMicrotask(flush) }

  const flush = () => {
    if (flushing) return
    flushing = true
    try {
      let pass = 0
      while (batch.size && pass++ < MAX_PASSES) {
        const list = batch
        batch = new Set() // swap: триггеры во время прохода уйдут в следующий
        // TODO(юзер): подумать над ПРОСТЫМ СПИСКОМ вместо Set+swap.
        activeList = list
        const sorted = [...list].sort((a, b) => a.depth - b.depth)
        for (const sc of sorted) {
          if (!list.has(sc)) continue // родитель уже перезапустил
          list.delete(sc)
          const n = sc.node
          if (!n || !n.parentNode) { // нода удалена/отцеплена — дохлый эффект
            // TODO(дефер-батч): узел могут вернуть глубже в этом же проходе —
            // тогда эффект лучше отложить во второй реестр и перепроверить.
            if (n) removeFromDropped(n)
            clearDeps(sc)
            continue
          }
          try { runSc(sc) } catch (e) { (window.reportError || console.error)(e) } // TODO если это фолбек для старых браузеров, то там чо console.error нету когда есть report? Или он чем-то лучше?
        }
        activeList = null
      }
      // TODO(юзер): при исчерпании MAX_PASSES ничего не форсим (root-а нет).
      // Сейчас остаток batch просто ждёт следующего триггера.
    } finally { flushing = false; scheduled = false; activeList = null; clearDropped() }
  }

  // Единственный раннер компонента: позиционируется на sc.node (или текущий
  // курсор для первого рендера), трекает в sc, проверяет «ровно 1 узел».
  const runSc = (sc) => {
    if (activeList) activeList.delete(sc)
    batch.delete(sc)
    clearDeps(sc)
    const n = sc.node
    if (n && n.parentNode) { parent = n.parentNode; cursor = n }
    const savedCounter = counter, savedDepth = depth, savedTracking = tracking, savedStack = stack.length
    counter = 0
    depth = sc.depth
    tracking = sc
    ID = sc.key // корневой узел компонента возьмёт ключ компонента в takeKey(cs_тега)
    try {
      sc.cb()
      if (counter !== 1) console.error('memo: компонент должен создать ровно один узел, получено ' + counter)
      else { // сами забираем корневой узел после fn (курсор стоит за ним)
        const root = cursor ? cursor.previousSibling : parent.lastChild
        // 1 DOM-узел = 1 identity = 1 scope. Если на узле уже висит чужой scope,
        // корень создал вложенный компонент — обёртку надо писать обычной функцией.
        /* dev */
        if (root._scope && root._scope !== sc) console.warn('memo: корень — не тег (узел занял вложенный компонент); пиши обычную функцию')
        /* /dev */
        root._key = sc.key;
        root._scope = sc;
        sc.node = root
      }
    } catch (e) {
      // TODO(R2): при throw снять диапазон/дитя и не оставлять «призраков».
      // Пока только пробрасываем наружу.
      throw e
    } finally {
      ID = null
      if (stack.length > savedStack) stack.length = savedStack // незакрытый end() не ломает соседей
      counter = savedCounter + 1
      depth = savedDepth
      tracking = savedTracking
    }
  }

  // ================= tags =================
  // Ядро темы «ключ × курсор»: узел для ключа в позиции курсора.
  // Порядок: курсор -> дропнутый -> скан (лишнее снимаем) -> null (создаёт вызывающий).
  const advanceCursorToKey = (k) => {
    if (cursor && cursor._key === k) return cursor
    const d = takeDropped(k)
    if (d) { if (cursor !== d) parent.insertBefore(d, cursor); return d }
    while (cursor) {
      const ck = cursor._key
      if (ck === k) return cursor
      if (ck == null) break // портал/чужой узел без ключа — барьер
      const nx = cursor.nextSibling
      dropNode(ck, cursor)
      cursor = nx
    }
    return null
  }
  const removeExtras = () => {
    while (cursor) {
      const nx = cursor.nextSibling
      if (cursor._key != null) dropNode(cursor._key, cursor)
      else cursor.remove()
      cursor = nx
    }
  }
  const textNode = (v) => {
    const s = String(v)
    let n = cursor
    if (!n || n.nodeType !== 3) { n = document.createTextNode(s); parent.insertBefore(n, cursor) }
    else if (n.data !== s) n.data = s
    if (n._key == null) n._key = TEXT
    cursor = n.nextSibling
    counter++
  }
  // `list` — read-only свойство, но валидный атрибут (datalist): уводим в attribute-ветку
  const inDom = (node, k) => (node.constructor._p ||= Object.create(null))[k] ??= !k.includes('-') && k in node && k !== 'list'
  const setProp = (node, k, v) => {
    if (k.startsWith('on')) {
      const ev = k.slice(2).toLowerCase()
      if (!node['_h_' + ev]) {
        node['_h_' + ev] = (e) => { const f = node._props[k]; if (typeof f === 'function') f.call(node, e) }
        node.addEventListener(ev, node['_h_' + ev])
      }
      return
    }
    if (inDom(node, k)) { if (node[k] !== v) node[k] = v }
    else {
      const s = v == null || v === false ? null : String(v)
      s == null ? node.removeAttribute(k) : node.setAttribute(k, s)
    }
  }
  const removeProp = (node, k) => {
    if (k.startsWith('on')) {
      const ev = k.slice(2).toLowerCase()
      if (node['_h_' + ev]) { node.removeEventListener(ev, node['_h_' + ev]); delete node['_h_' + ev] }
      return
    }
    if (inDom(node, k)) node[k] = ''
    node.removeAttribute(k)
  }
  const patchProps = (node, props) => {
    const prev = node._props || {}, next = props || {}
    for (const k in next) { // TODO проверить на корректность с разными тегами и пропсами
      const controlled = (k === 'value' || k === 'checked' || k === 'selected') && node[k] !== next[k]
      if (prev[k] !== next[k] || controlled) setProp(node, k, next[k])
    }
    for (const k in prev) if (!(k in next)) removeProp(node, k)
    node._props = next
  }

  const el = (name, cs, ...args) => {
    const props = isProps(args[0]) ? args.shift() : null
    // TODO(props.id): ключ тега можно брать и из props.id (keyed-списки LI({id})).
    // Пока props.id игнорится; решить: ID ?? CS или props.id ?? takeKey(cs).
    const k = takeKey(cs)
    let n = advanceCursorToKey(k)
    /* dev */
    // Тег сменить может только корень компонента (k !== cs): у плоского тега узел
    // привязан к своему cs. В проде эту диагностику срезает strip-dev (D37).
    if (k !== cs && n && n.localName !== name) console.warn('memo: тег корня сменился (' + n.localName + ' → ' + name + ') — не поддержано')
    /* /dev */
    if (!n) { n = document.createElement(name); parent.insertBefore(n, cursor) }
    n._key = k
    patchProps(n, props)
    // Содержимое: первый аргумент — текст (и у листа, и у блока с детьми);
    // хвостовой `null` (его ставит патчер) = ЛИСТ, блока нет. Блок закроет `end()`.
    const sp = parent, sc = counter
    parent = n; cursor = n.firstChild; counter = 0
    /* dev */
    // Контент тега — скаляр. Объект/узел — через EMIT(); функция чаще всего стухший
    // thunk (D33/D34). Иначе textNode сделает String() и в DOM уедет исходник.
    if (args[0] != null && (typeof args[0] === 'object' || typeof args[0] === 'function')) console.warn('тег ' + name + ': контент — не скаляр (' + typeof args[0] + '); узел/объект → EMIT(), функцию вызови')
    /* /dev */
    if (args[0] != null && typeof args[0] !== 'boolean') textNode(args[0])
    if (args[args.length - 1] === null) { // лист: прежних детей снять
      removeExtras()
      cursor = n.nextSibling; parent = sp; counter = sc + 1
    } else stack.push({ n, sp, sc })
    return n
  }
  const end = () => {
    const f = stack.pop()
    if (!f) throw new Error('end(): нет открытого элемента')
    removeExtras()
    cursor = f.n.nextSibling; parent = f.sp; counter = f.sc + 1
  }
  // EMIT — единственный контент-примитив: скаляр -> текст, Node -> вставка (без клона),
  // плоский массив -> раскрыть; object/function/symbol -> ошибка. cs (от патчера) -> ключи узлов.
  const EMIT = (cs, ...vals) => {
    for (let i = 0, list = vals.flat(), n = list.length; i < n; i++) {
      const v = list[i]
      if (v == null || typeof v === 'boolean') continue
      if (v instanceof Node) {
        if (cursor !== v) parent.insertBefore(v, cursor)
        if (v._key == null) v._key = cs == null ? TEXT : i ? cs + '#' + i : cs
        cursor = v.nextSibling
        counter++
      } else if (typeof v === 'string' || typeof v === 'number' || typeof v === 'bigint') textNode(v)
      else throw new Error('EMIT: неожиданное значение ' + typeof v)
    }
  }

  const cssCache = new Map()
  const css = (t) => {
    let s = cssCache.get(t)
    if (s === undefined) cssCache.set(t, s = window.J.css(t))
    if (!parent.classList.contains(s)) parent.classList.add(s)
    return s
  }

  // ================= memo =================
  const argKey = (x) => (typeof x === 'function' ? 0 : (x !== null && typeof x === 'object' ? (x[UID] ?? x) : x))
  const sigEq = (a, b) => !!a && a.length === b.length && a.every((v, i) => v === b[i])
  const memoStats = { ran: 0, skipped: 0 }

  const memo = (fn) => (cs, ...rest) => {
    const k = takeKey(cs)
    const n = advanceCursorToKey(k)
    let sc = n && n._scope && n._scope.key === k ? n._scope : null
    const sig = rest.map(argKey) // TODO м.б. проверить сначала sc, потом число аргументов, а потом мапить? Разобраться как дешевле выйдет
    if (sc && sigEq(sc.sig, sig)) { // аргументы те же — не дёргаем дитя
      cursor = n.nextSibling
      counter++
      memoStats.skipped++
      return
    }
    if (!sc) { sc = { key: k, depth: 0, cb: null, node: n || null, deps: new Set(), sig: null }; if (n) n._scope = sc }
    sc.cb = () => fn(...rest)
    sc.sig = sig
    sc.depth = depth + 1
    memoStats.ran++
    runSc(sc)
  }

  // ================= mount =================
  // Корень — обычный memo-компонент с реальным узлом. Свой scope он создаёт
  // сам; mount лишь ставит позицию и зовёт обёртку.
  const mount = (host, fn, ...args) => {
    parent = host; cursor = host.firstChild
    fn('#root', ...args)
    removeExtras()
    clearDropped()
  }

  const tags = new Proxy(Object.create(null), { get: (t, name) => (t[name] ||= (...a) => el(name, ...a)) })
  // TODO чекнуть перформанс. М.б. вместо прокси честный объект дать?

  window.data = data
  window.tags = tags
  window.end = end
  window.EMIT = EMIT
  window.css = css
  window.memo = memo
  window.mount = mount
  window.__memoStats = memoStats
})()
