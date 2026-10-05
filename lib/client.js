// SPDX-License-Identifier: MIT
// Client face: the goal-round-compact card inside 设置 → 插件 → 插件配置.
//
// Form B: this plugin registers one card into the keyed 'settings.plugin.item'
// slot, keyed by its own settings namespace. That tab only decides which
// namespaces to dispatch; what a namespace MEANS is learned by nobody but this
// file. Reads and writes both go through one bound settings scope, so the card
// never touches remote.settings directly and never learns a wire shape.
//
// The five fields below are the whole of the global layer. Per-model overrides
// (modelPolicies) stay a host-side configuration capability on purpose: they are
// matched by exact provider+model equality, are not edited here, and are rare
// enough that a file location is the right interface. The card says so instead
// of pretending to offer an editor for them.
//
// This file is a hand-written client bundle: it is loaded by
// window.__ModuleLoader__.load, so it must not use import/export syntax.
window.__ModuleLoader__.load({
  id: 'dsh-goal-round-compact',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })
    var react = require('react')

    // The settings namespace this plugin's host half registers. Spelled here
    // rather than imported: a client package must not depend on a Host package,
    // and the host half spells the same value in src/settings.js.
    var NS = 'goal-round-compact'

    // Shown when the draft was built against a section that no longer stands.
    var STALE_PREFIX = '草稿已过期：设置在你编辑期间被其他位置改动。'

    // The global layer, in the order the card shows them. 'key' is the field name
    // inside the namespace section, i.e. the single path segment every write op
    // addresses. No default VALUES live in this file on purpose: the host half
    // owns them, and a second copy here would drift the moment a default moves.
    var FIELDS = [
      {
        key: 'enabled',
        type: 'boolean',
        label: '启用 Goal 轮次压缩',
        hint: '在每个 goal 轮次边界后自动压缩一次对话。关闭后插件不改动会话上下文，但下面四项仍会保存。',
      },
      {
        key: 'minTokensBeforeCompact',
        type: 'number',
        step: 1000,
        min: 0,
        label: '压缩触发阈值（token）',
        hint: '轮次边界时，若当前上下文 token 数达到该值就触发压缩。这是绝对 token 数，不随模型上下文窗口缩放。',
      },
      {
        key: 'retainTokens',
        type: 'number',
        step: 1000,
        min: 0,
        label: '压缩后保留（token）',
        hint: '绝对 token 数，不随上下文窗口缩放。必须显著小于压缩触发阈值，否则宿主会拒绝这次写入。',
      },
      {
        key: 'minGrowthTokens',
        type: 'number',
        step: 1000,
        min: 0,
        label: '两次压缩之间的最小增长（token）',
        hint: '距上次压缩增长不足该值时跳过本次压缩，避免上下文没涨多少就被反复压缩。',
      },
      {
        key: 'maxCompactionsPerGoal',
        type: 'number',
        step: 1,
        min: 0,
        label: '单个 goal 最多压缩次数',
        hint: '达到该次数后，这个 goal 不再继续触发压缩。',
      },
    ]

    var FIELD_BY_KEY = {}
    for (var i = 0; i < FIELDS.length; i += 1) FIELD_BY_KEY[FIELDS[i].key] = FIELDS[i]

    var style = {
      root: { display: 'flex', flexDirection: 'column', gap: 12, padding: '4px 0' },
      intro: { margin: 0, fontSize: 13, lineHeight: '20px', color: 'var(--dsw-alias-label-tertiary, #888)' },
      row: { display: 'flex', flexDirection: 'column', gap: 4 },
      rowHead: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
      label: { fontSize: 13, fontWeight: 500, lineHeight: '20px', color: 'var(--dsw-alias-label-primary, inherit)' },
      help: { margin: 0, fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-tertiary, #888)' },
      input: {
        height: 32, borderRadius: 8, fontSize: 13, padding: '0 8px', maxWidth: 220,
        border: '1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.35))',
        background: 'var(--dsw-specific-input-major, transparent)',
        color: 'var(--dsw-alias-label-primary, inherit)',
      },
      check: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: 'var(--dsw-alias-label-primary, inherit)' },
      tag: { fontSize: 11, lineHeight: '16px', color: 'var(--dsw-alias-label-tertiary, #888)' },
      actions: { display: 'flex', alignItems: 'center', gap: 10, paddingTop: 4, flexWrap: 'wrap' },
      button: {
        height: 32, padding: '0 14px', borderRadius: 8, fontSize: 13, cursor: 'pointer',
        border: '1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.35))',
        background: 'var(--dsw-specific-input-major, transparent)',
        color: 'var(--dsw-alias-label-primary, inherit)',
      },
      link: { height: 'auto', padding: '0', border: 0, background: 'none', fontSize: 12, cursor: 'pointer', textDecoration: 'underline' },
      primary: { background: 'var(--dsw-alias-state-info-primary, #3b82f6)', borderColor: 'transparent', color: '#fff' },
      notice: {
        border: '1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.25))',
        borderRadius: 8, padding: '8px 10px', fontSize: 12, lineHeight: '18px',
      },
      ok: { color: 'var(--dsw-alias-label-tertiary, #888)' },
      err: { color: 'var(--dsw-alias-state-error-primary, #d9534f)' },
      warn: { color: 'var(--dsw-alias-state-warning-primary, #b8860b)' },
    }

    function record(value) {
      return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {}
    }

    function has(object, key) {
      return object !== null && typeof object === 'object' && Object.prototype.hasOwnProperty.call(object, key)
    }

    /** Render a section number for editing; anything non-numeric edits as empty. */
    function formatNumber(value) {
      return typeof value === 'number' && Number.isFinite(value) ? String(value) : ''
    }

    /**
     * One control's draft text, turned back into the JSON value a write op needs.
     * An empty draft is refused rather than guessed at: these fields have no
     * meaningful "cleared" state other than reverting to the composition layer,
     * which the card offers as its own gesture.
     */
    function parseField(field, draft) {
      if (field.type === 'boolean') return { ok: true, value: draft === true }
      var trimmed = typeof draft === 'string' ? draft.trim() : ''
      if (trimmed === '') return { ok: false }
      var parsed = Number(trimmed)
      if (!Number.isFinite(parsed)) return { ok: false }
      return { ok: true, value: parsed }
    }

    /** A host-side fence refusal, however the transport chose to spell it. */
    function isConflict(error) {
      if (error === null || typeof error !== 'object') return false
      var code = String(error.code || (error.data && error.data.code) || '')
      if (code.toLowerCase().indexOf('conflict') !== -1) return true
      return String(error.message || '').toLowerCase().indexOf('conflict') !== -1
    }

    function describeError(error) {
      if (error === null || error === void 0) return '未知错误'
      var message = error.message ? String(error.message) : String(error)
      var code = error.code ? String(error.code) : ''
      return code === '' ? message : code + '：' + message
    }

    function fieldLabel(key) {
      const field = FIELD_BY_KEY[key]
      return field === undefined ? key : field.label
    }

    /**
     * Advisory sanity check, not validation. retainTokens is an absolute token
     * count that does NOT scale with the model context window, so a value carried
     * over from a large-window model can exceed the threshold on a small-window
     * one. The host validator stays authoritative; this only says so beforehand.
     */
    function pressureWarning(fields) {
      const threshold = fields.minTokensBeforeCompact
      const retain = fields.retainTokens
      if (!threshold.valid || !retain.valid) return null
      if (retain.value === '' || threshold.value === '') return null
      const t = Number(threshold.value)
      const r = Number(retain.value)
      if (!Number.isFinite(t) || !Number.isFinite(r)) return null
      if (r < t) return null
      return '「压缩后保留」不小于「压缩触发阈值」，宿主会拒绝这次保存：压缩后剩下的上下文已经装不下任何内容。'
    }

    /**
     * The card's staged form over the 'goal-round-compact' settings scope.
     *
     * Drafts are staged locally and written as ONE atomic mutate() carrying the
     * revision the draft was started from. Omitting that revision silently
     * re-fences the write at the latest queued revision, i.e. no fence at all, so
     * a conflict is reported to the user instead of being retried away.
     */
    class GoalRoundCompactCard {
      constructor(scope) {
        this.scope = scope
        this.listeners = new Set()
        this.draft = null
        this.draftRevision = undefined
        this.resets = new Set()
        this.saving = false
        this.conflicted = false
        this.notice = null
        this.getSnapshot = () => this.snapshot
        this.subscribe = (listener) => {
          this.listeners.add(listener)
          return () => { this.listeners.delete(listener) }
        }
        this.unsubscribe = scope.subscribe(() => {
          this.absorb()
          this.publish()
        })
        this.absorb()
        this.snapshot = this.project()
      }

      dispose() {
        if (typeof this.unsubscribe === 'function') this.unsubscribe()
        this.listeners.clear()
      }

      /** Is there a section standing to edit at all? */
      ready() {
        const snapshot = this.scope.getSnapshot()
        return snapshot.status === 'ready' && snapshot.value !== undefined && snapshot.value !== null
      }

      /**
       * Re-seed the draft whenever the user is not mid-edit. A draft the user is
       * still holding is left alone on purpose: that is exactly the case the
       * revision fence exists to catch, and overwriting it would hide the race
       * instead of reporting it.
       */
      absorb() {
        if (!this.ready()) {
          this.draft = null
          this.draftRevision = undefined
          this.resets = new Set()
          return
        }
        if (this.draft === null || (!this.dirty() && !this.conflicted)) this.seed()
      }

      seed() {
        const snapshot = this.scope.getSnapshot()
        const value = record(snapshot.value)
        this.draft = {}
        for (const field of FIELDS) {
          this.draft[field.key] = field.type === 'boolean' ? value[field.key] === true : formatNumber(value[field.key])
        }
        this.draftRevision = snapshot.revision
        this.resets = new Set()
        this.conflicted = false
      }

      /** Stage one control's new input. */
      edit(key, draft) {
        if (this.draft === null) return
        this.draft[key] = draft
        this.resets.delete(key)
        this.notice = null
        this.publish()
      }

      /**
       * Stage a revert: the save emits an 'unset' for this field, so it re-inherits
       * the composition layer (cordis.patch.yml) instead of being pinned to a copy
       * of today's default.
       */
      resetField(key) {
        if (this.draft === null) return
        const base = record(this.scope.getSnapshot().base)
        const field = FIELD_BY_KEY[key]
        if (field === undefined || !has(base, key)) {
          this.notice = { tone: 'err', text: '「' + fieldLabel(key) + '」没有可回落的组合层默认值，无法还原。' }
          this.publish()
          return
        }
        this.resets.add(key)
        this.draft[key] = field.type === 'boolean' ? base[key] === true : formatNumber(base[key])
        this.conflicted = false
        this.notice = null
        this.publish()
      }

      /** Drop every staged edit and read the form back from the Host. */
      discard() {
        this.notice = null
        this.conflicted = false
        this.saving = false
        if (this.ready()) this.seed()
        else this.draft = null
        this.publish()
      }

      /**
       * Every staged edit a save would write, in field order. A draft that is not
       * a value its field accepts carries no write and is reported as invalid, so
       * the save refuses rather than dropping the edit.
       */
      plan() {
        const snapshot = this.scope.getSnapshot()
        const value = record(snapshot.value)
        const user = record(snapshot.user)
        const ops = []
        const invalid = []
        for (const field of FIELDS) {
          if (this.resets.has(field.key)) {
            if (has(user, field.key)) ops.push({ op: 'unset', path: [field.key] })
            continue
          }
          const parsed = parseField(field, this.draft[field.key])
          if (!parsed.ok) {
            invalid.push(field.key)
            continue
          }
          if (Object.is(parsed.value, value[field.key])) continue
          ops.push({ op: 'set', path: [field.key], value: parsed.value })
        }
        return { ops, invalid }
      }

      dirty() {
        if (this.draft === null) return false
        return this.plan().ops.length > 0
      }

      /**
       * Write every staged edit under the draft's revision fence.
       *
       * A conflict is NOT retried: the drafts were built against a section that no
       * longer stands, so silently re-applying them could overwrite whatever
       * landed in between. The user is told to discard and re-read instead.
       */
      async save() {
        if (this.saving) return
        if (this.draft === null) return
        const snapshot = this.scope.getSnapshot()
        if (snapshot.status !== 'ready') {
          this.notice = { tone: 'err', text: STALE_PREFIX + '命名空间未被宿主提供，无法保存。' }
          this.publish()
          return
        }
        if (!snapshot.writable) {
          this.notice = { tone: 'err', text: '设置当前为只读（模式：' + String(snapshot.mode) + '），无法保存。' }
          this.publish()
          return
        }
        const plan = this.plan()
        if (plan.invalid.length > 0) {
          this.notice = { tone: 'err', text: '请先修正标红的输入再保存。' }
          this.publish()
          return
        }
        if (plan.ops.length === 0) return
        if (this.draftRevision !== undefined && snapshot.revision !== this.draftRevision) {
          this.conflicted = true
          this.notice = { tone: 'err', text: STALE_PREFIX + '请点「放弃修改」重新读取后再改。' }
          this.publish()
          return
        }
        const fence = this.draftRevision
        this.saving = true
        this.notice = null
        this.conflicted = false
        this.publish()
        try {
          await this.scope.mutate(plan.ops, fence)
          this.notice = { tone: 'ok', text: '已保存，立即生效（无需重启 DSH）。' }
        } catch (error) {
          if (isConflict(error)) {
            this.conflicted = true
            this.notice = { tone: 'err', text: STALE_PREFIX + '请点「放弃修改」重新读取后再改。' }
          } else {
            this.notice = { tone: 'err', text: '保存失败：' + describeError(error) }
          }
        } finally {
          this.saving = false
          this.publish()
        }
      }

      /** What the view renders, rebuilt only when something actually changed. */
      project() {
        const snapshot = this.scope.getSnapshot()
        const user = record(snapshot.user)
        const base = record(snapshot.base)
        const ready = this.ready()
        const plan = this.draft === null ? { ops: [], invalid: [] } : this.plan()
        const fields = {}
        for (const field of FIELDS) {
          const draft = this.draft === null ? (field.type === 'boolean' ? false : '') : this.draft[field.key]
          const parsed = this.draft === null ? { ok: false } : parseField(field, draft)
          fields[field.key] = {
            value: draft,
            valid: parsed.ok,
            overridden: has(user, field.key),
            resettable: has(base, field.key),
            resetting: this.resets.has(field.key),
          }
        }
        return {
          status: snapshot.status,
          ready,
          writable: snapshot.writable,
          mode: snapshot.mode,
          revision: snapshot.revision,
          draftRevision: this.draftRevision,
          fields,
          dirty: plan.ops.length > 0,
          invalid: plan.invalid.length > 0,
          saving: this.saving,
          conflicted: this.conflicted,
          notice: this.notice,
          pressure: pressureWarning(fields),
        }
      }

      publish() {
        this.snapshot = this.project()
        for (const listener of Array.from(this.listeners)) listener()
      }
    }

    // A card that never got its controller still renders something readable
    // instead of throwing inside the slot's error boundary.
    var NOOP_SUBSCRIBE = function () { return function () {} }
    var EMPTY_FIELDS = (function () {
      const out = {}
      for (const field of FIELDS) {
        out[field.key] = { value: field.type === 'boolean' ? false : '', valid: false, overridden: false, resettable: false, resetting: false }
      }
      return out
    })()
    var EMPTY_SNAPSHOT = {
      status: 'loading', ready: false, writable: false, mode: 'host',
      revision: undefined, draftRevision: undefined, fields: EMPTY_FIELDS,
      dirty: false, invalid: false, saving: false, conflicted: false, notice: null, pressure: null,
    }
    function emptySnapshot() { return EMPTY_SNAPSHOT }

    function useCardSnapshot(card) {
      const present = card !== null && card !== void 0
      const subscribe = present && typeof card.subscribe === 'function' ? card.subscribe : NOOP_SUBSCRIBE
      const getSnapshot = present && typeof card.getSnapshot === 'function' ? card.getSnapshot : emptySnapshot
      if (typeof react.useSyncExternalStore === 'function') {
        return react.useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
      }
      // React 17 fallback; DSH ships React 18+, so this path is belt-and-braces.
      const pair = react.useState(getSnapshot())
      react.useEffect(function () {
        return subscribe(function () { pair[1](getSnapshot()) })
      }, [subscribe, getSnapshot])
      return pair[0]
    }

    function Notice(props) {
      const notice = props.notice
      if (notice === null || notice === void 0) return null
      const tone = notice.tone === 'err' ? style.err : notice.tone === 'warn' ? style.warn : style.ok
      return react.createElement('p', { style: style.notice }, react.createElement('span', { style: tone }, notice.text))
    }

    /**
     * Render the card.
     * @param props - the card's controller, handed over by the slot registration.
     * @returns the card.
     */
    function GoalRoundCompactCardView(props) {
      const card = props !== null && props !== void 0 ? props.goalRoundCompact : void 0
      const snap = useCardSnapshot(card)
      const disabled = !snap.ready || !snap.writable || snap.saving

      const rows = FIELDS.map(function (field) {
        const state = snap.fields[field.key]
        const control = field.type === 'boolean'
          ? react.createElement('label', { key: 'control', style: style.check },
              react.createElement('input', {
                type: 'checkbox',
                checked: state.value === true,
                disabled,
                onChange: function (event) { card.edit(field.key, event.target.checked) },
              }),
              '在每个 goal 轮次边界后压缩一次对话')
          : react.createElement('div', { key: 'control', style: style.rowHead },
              react.createElement('input', {
                type: 'number',
                style: Object.assign({}, style.input, state.valid ? {} : { borderColor: 'var(--dsw-alias-state-error-primary, #d9534f)' }),
                value: state.value,
                min: field.min,
                step: field.step,
                disabled,
                onChange: function (event) { card.edit(field.key, event.target.value) },
              }),
              state.overridden && state.resettable
                ? react.createElement('button', {
                    key: 'reset', type: 'button', style: style.link,
                    disabled: disabled || state.resetting,
                    onClick: function () { card.resetField(field.key) },
                  }, '还原默认值')
                : null)
        const head = [react.createElement('span', { key: 'label', style: style.label }, field.label)]
        if (state.overridden) {
          head.push(react.createElement('span', { key: 'tag', style: style.tag }, state.resetting ? '待还原' : '已覆盖默认值'))
        }
        return react.createElement('div', { key: field.key, style: style.row },
          react.createElement('div', { style: style.rowHead }, head),
          control,
          react.createElement('span', { style: style.help }, field.hint))
      })

      const banner = !snap.ready
        ? react.createElement('div', { key: 'banner', style: style.notice },
            react.createElement('span', { style: style.warn },
              snap.status === 'loading'
                ? '正在读取设置命名空间 ' + NS + '…'
                : '设置命名空间 ' + NS + ' 未被宿主提供：下面的输入框保持禁用。'),
            react.createElement('p', { style: style.help },
              '通常是插件的 host 半侧尚未注册该命名空间（settings 服务缺失、插件被禁用，或改动 package.json 后尚未重启宿主）。'))
        : null

      const pressure = snap.pressure !== null
        ? react.createElement('p', { key: 'pressure', style: Object.assign({}, style.help, { color: 'var(--dsw-alias-state-warning-primary, #b8860b)' }) }, snap.pressure)
        : null

      const notice = snap.notice === null || snap.notice === void 0
        ? null
        : react.createElement('div', { key: 'notice', style: style.row }, Notice({ notice: snap.notice }))

      return react.createElement('div', { style: style.root },
        react.createElement('p', { style: style.intro },
          '本页只编辑全局层的五个参数。按模型的覆盖（modelPolicies）是有意保留的 host 侧配置能力，',
          '需要在 settings.yaml 的 ' + NS + ' 块里手写 { provider, model, … }：严格相等匹配、首命中、逐字段回落全局。'),
        banner,
        rows,
        pressure,
        react.createElement('div', { style: style.actions },
          react.createElement('button', {
            type: 'button',
            style: Object.assign({}, style.button, style.primary),
            disabled: disabled || !snap.dirty || snap.invalid,
            onClick: function () { card.save() },
          }, snap.saving ? '保存中…' : '保存'),
          react.createElement('button', {
            type: 'button', style: style.button,
            disabled: snap.saving || !snap.dirty,
            onClick: function () { card.discard() },
          }, '放弃修改'),
          snap.ready
            ? react.createElement('span', { style: style.tag },
                '草稿基于 revision ' + String(snap.draftRevision) + '，当前 revision ' + String(snap.revision))
            : null),
        notice)
    }

    // 'remote' and 'remote.settings' are declared because this card renders inside
    // the remote-backed settings surface, and a plugin rendering there without
    // those declared parks itself instead of failing later inside a slot. This
    // card's own reads and writes go through the bound scope, not remote.settings.
    var inject = ['slots', 'connection', 'remote', 'remote.settings', 'settingsScope']

    /**
     * Mount the card.
     * @param ctx - the browser plugin context.
     */
    function apply(ctx) {
      const scope = ctx.settingsScope.bind({ namespace: NS })
      const card = new GoalRoundCompactCard(scope)
      ctx.effect(function () { return function () { card.dispose() } }, 'goal-round-compact: card disposal')
      ctx.slots.inject('settings.plugin.item', function () {
        return ctx.slots.register({
          name: 'settings.plugin.item',
          key: NS,
          inject: function () { return { goalRoundCompact: card } },
        }, GoalRoundCompactCardView)
      })
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
