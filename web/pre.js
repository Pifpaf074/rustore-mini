// pre.js — рантайм-патчер (блочный синтаксис + call-site). Без сборки и БЕЗ замыканий.
//   DIV(props)          -> tags.div("app#3", props, null)           (пустой элемент)
//   DIV(props) { body } -> { tags.div("app#3", props); body; end() }  (контейнер)
//   DIV(props); { body }-> то же: `;` перед блоком допускается (валидный JS)
//   DIV(props, text)    -> tags.div("app#3", props, text, null)      (лист с текстом)
//   ROW(item)           -> ROW(item)      (компонент: аргументы не трогаем)
// Блок -> `{ tags.X("app#3", args); body; end() }`: скобки держат ветку, поэтому
// `if (ok) DIV() { … }` корректен, а `end()` закрывает элемент через стек движка
// (никаких колбэков/аллокаций). Хвостовой null у тега без блока форсит ЛИСТ
// (контейнер = тег с блоком): иначе `TH()` без аргументов движок счёл бы контейнером.
// Первый аргумент tags.X — строка call-site (#N), стабильная на загрузку и уникальная.
(() => {
  const TAGS = new Set(('a,abbr,address,area,article,aside,audio,b,bdi,bdo,blockquote,br,button,canvas,caption,cite,code,col,colgroup,data,datalist,dd,del,details,dfn,dialog,div,dl,dt,em,embed,fieldset,figcaption,figure,footer,form,h1,h2,h3,h4,h5,h6,header,hgroup,hr,i,iframe,img,input,ins,kbd,label,legend,li,main,map,mark,menu,meter,nav,object,ol,optgroup,option,output,p,picture,pre,progress,q,rp,rt,ruby,s,samp,section,select,slot,small,source,span,strong,sub,summary,sup,table,tbody,td,template,textarea,tfoot,th,thead,time,tr,track,u,ul,var,video,wbr').split(','))
  const IDCH = /[A-Za-z0-9_$]/, UPPER = /^[A-Z][A-Z0-9_]*$/, START = /[A-Za-z_$]/, WS = /\s/
  const KW = new Set(['function', 'class', 'new', 'get', 'set', 'static', 'async'])
  let SRC = '', n = 0
  /* dev */
  // Не 100%: грубая проверка ключей в props-объекте (строки/вложенность не разбираем).
  // Это подсказка в dev, а не контроль: ложное срабатывание = лишний warn.
  const hasKey = (args, k) => new RegExp('(?:^|[{,]\\s*)' + k + '\\s*:').test(args)
  const devWarn = (lower, args) => {
    if (hasKey(args, 'dataset')) console.warn("pre: { dataset } — read-only свойство; пиши 'data-*'")
    if (hasKey(args, 'options')) console.warn('pre: { options } — read-only свойство; используй детей OPTION')
    if (hasKey(args, 'form')) console.warn('pre: { form } — read-only свойство; проп не сработает')
    if (lower === 'select' && hasKey(args, 'value')) console.warn('pre: SELECT { value } — не работает на первом рендере; используй OPTION({ selected })')
  }
  // Имя слева от `memo(...)`: `X = memo(` -> X (иначе пусто). Для проверки ALL-CAPS.
  const prevIdent = (i) => { let k = i - 1; while (k >= 0 && WS.test(SRC[k])) k--; if (SRC[k] !== '=') return ''; k--; while (k >= 0 && WS.test(SRC[k])) k--; const e = k + 1; while (k >= 0 && IDCH.test(SRC[k])) k--; return SRC.slice(k + 1, e) }
  /* /dev */

  const prevWord = (i) => { let k = i - 1; while (k >= 0 && WS.test(SRC[k])) k--; const e = k + 1; while (k >= 0 && IDCH.test(SRC[k])) k--; return SRC.slice(k + 1, e) }
  const prevCh = (i) => { let k = i - 1; while (k >= 0 && WS.test(SRC[k])) k--; return k < 0 ? '' : SRC[k] }
  const skipStr = (i) => { const q = SRC[i]; i++; while (i < SRC.length && SRC[i] !== q) { if (SRC[i] === '\\') i++; i++ } return i + 1 }
  // Индекс парной скобки o..c. Пропускает строки/шаблоны/комментарии (не регекспы).
  const match = (i, o, c) => {
    let d = 0
    while (i < SRC.length) {
      const ch = SRC[i]
      if (ch === '/' && SRC[i + 1] === '/') { const j = SRC.indexOf('\n', i); i = j < 0 ? SRC.length : j; continue }
      if (ch === '/' && SRC[i + 1] === '*') { const j = SRC.indexOf('*/', i + 2); i = j < 0 ? SRC.length : j + 2; continue }
      if (ch === '"' || ch === "'" || ch === '`') { i = skipStr(i); continue }
      if (ch === o) d++
      else if (ch === c && --d === 0) return i
      i++
    }
    return SRC.length
  }

  // Рекурсивно по [a,b) исходника. Возвращает преобразованный код.
  const tr = (a, b, file) => {
    let out = '', i = a
    while (i < b) {
      const ch = SRC[i]
      if (ch === '/' && SRC[i + 1] === '/') { let j = SRC.indexOf('\n', i); if (j < 0 || j > b) j = b; out += SRC.slice(i, j); i = j; continue }
      if (ch === '/' && SRC[i + 1] === '*') { let j = SRC.indexOf('*/', i + 2); j = (j < 0 || j + 2 > b) ? b : j + 2; out += SRC.slice(i, j); i = j; continue }
      if (ch === '"' || ch === "'" || ch === '`') { const j = Math.min(skipStr(i), b); out += SRC.slice(i, j); i = j; continue }
      if (START.test(ch)) {
        let j = i; while (j < b && IDCH.test(SRC[j])) j++
        const name = SRC.slice(i, j)
        /* dev */
        // Компонент-конвенция: memo(...) -> имя ALL-CAPS (иначе pre.js не вставит cs);
        // обычная all-caps функция с аргументом — cs сдвинет аргумент.
        if (name === 'memo') { const a = prevIdent(i); if (a && !UPPER.test(a)) console.warn('pre: memo присвоен имени ' + a + ' (не ALL-CAPS) — pre.js не вставит cs; переименуй в ALL-CAPS') }
        if (UPPER.test(name) && prevWord(i) === 'function') { const op = SRC.indexOf('(', j), cp = match(op, '(', ')'); if (SRC.slice(op + 1, cp).trim()) console.warn('pre: обычная all-caps функция ' + name + ' с аргументом — pre.js вставит cs, аргумент сдвинется; сделай memo или переименуй') }
        // Имя-тег: ALL-CAPS имя, чей lowercase — HTML-тег, при вызове станет tags.<тег>.
        if (UPPER.test(name)) {
          let t = j; while (t < b && WS.test(SRC[t])) t++
          if (SRC[t] === '=' && SRC[t + 1] !== '=' && SRC[t + 1] !== '>') {
            const low = name.toLowerCase()
            if (TAGS.has(low)) console.warn('pre: имя ' + name + ' совпадает с тегом <' + low + '> — вызов ' + name + '(...) станет tags.' + low + '(...), а не компонентом; переименуй')
          }
        }
        /* /dev */
        if (name === 'CSS' && prevCh(i) !== '.') { out += 'css'; i = j; continue } // CSS`...` -> css`...`
        if (UPPER.test(name) && SRC[j] === '(' && !KW.has(prevWord(i)) && prevCh(i) !== '.') {
          const lower = name.toLowerCase()
          const cp = match(j, '(', ')')
          /* dev */
          devWarn(lower, SRC.slice(j + 1, cp))
          /* /dev */
          let nb = cp + 1; while (nb < b && WS.test(SRC[nb])) nb++
          if (nb < b && SRC[nb] === ';') { nb++; while (nb < b && WS.test(SRC[nb])) nb++ } // DIV(); { … }
          if (nb < b && SRC[nb] === '{' && TAGS.has(lower)) { // блочная форма -> { tags.X(...); body; end() }
            const cb = match(nb, '{', '}'), args = tr(j + 1, cp, file)
            out += '{ tags.' + lower + '(' + JSON.stringify(file + '#' + n++) + (args.trim() ? ', ' + args : '') + ');' + tr(nb + 1, cb, file) + '; end() }'
            i = cb + 1; continue
          }
          if (!TAGS.has(lower)) { // компонент: патчер даёт cs ВСЕМ all-caps
            const cp = match(j, '(', ')')
            const args = tr(j + 1, cp, file)
            out += name + '(' + JSON.stringify(file + '#' + n++) + (args.trim() ? ', ' + args : '') + ')'
            i = cp + 1; continue
          }
          const args = tr(j + 1, cp, file) // тег без блока -> лист (хвостовой null)
          out += 'tags.' + lower + '(' + JSON.stringify(file + '#' + n++) + (args.trim() ? ', ' + args : '') + ', null)'
          i = cp + 1; continue
        }
        out += name; i = j; continue
      }
      out += ch; i++
    }
    return out
  }

  const el = document.getElementById('app-src')
  if (!el) return
  const file = el.dataset.file || (el.dataset.src ? el.dataset.src.split('/').pop() : 'app')
  const run = (text) => {
    SRC = text
    window.__patched = tr(0, SRC.length, file)
    ;(0, eval)(window.__patched) // indirect eval → глобальная область
  }
  const src = el.dataset.src // внешний исходник: <script type="text/plain" id="app-src" data-src="app.src.js">
  if (src) fetch(src).then((r) => r.text()).then(run, (e) => { throw new Error('pre: не загрузить ' + src + ': ' + e.message) })
  else run(el.textContent)
})()
