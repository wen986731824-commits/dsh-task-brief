/**
 * dsh-task-brief — Web client half (module-loader bundle).
 *
 * One compact hint in the New Session hero row: the first message of a new
 * Session will be answered with a task brief. The hero row only renders for a
 * blank Session, so this needs no session data of its own.
 */
window.__ModuleLoader__.load({
  id: 'dsh-task-brief',
  factory(require) {
    var React = require('react')
    var h = React.createElement
    var NS = 'dsh-task-brief'

    var zh = {
      hint: '首轮先出任务简报',
      hintTitle: '新会话的第一条任务会先给出任务简报：任务、类型、难度、关键要求、工作量、Token 与时间估算、推荐的模型和思考等级。简报之后直接开工，只推荐不自动切换模型。',
    }
    var en = {
      hint: 'Task brief first',
      hintTitle: 'The first task of a new Session is answered with a task brief: task, type, difficulty, requirements, workload, token and time estimates, and the recommended model with reasoning effort. Work starts right after it; models are recommended, never switched automatically.',
    }

    var S = {
      chip: {
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        height: 26,
        padding: '0 10px',
        borderRadius: 999,
        border: '1px solid var(--dsw-alias-border-l1)',
        background: 'var(--dsw-alias-bg-layer-1)',
        color: 'var(--dsw-alias-label-secondary)',
        font: 'inherit',
        fontSize: 12,
        lineHeight: 1,
        whiteSpace: 'nowrap',
        cursor: 'help',
        userSelect: 'none',
      },
      dot: {
        width: 6,
        height: 6,
        borderRadius: 3,
        background: 'var(--dsw-alias-brand-primary)',
        flex: '0 0 auto',
      },
    }

    function TaskBriefHint(props) {
      var t = props.t || function (key) { return (zh[key] != null ? zh[key] : key) }
      return h('span', {
        style: S.chip,
        title: t('hintTitle'),
        role: 'note',
        'aria-label': t('hintTitle'),
      },
        h('span', { style: S.dot, 'aria-hidden': true }),
        h('span', null, t('hint'))
      )
    }

    return {
      name: 'dsh-task-brief',
      inject: ['slots', 'locale'],
      apply: function (ctx) {
        ctx.effect(function () {
          return ctx.locale.register(NS, { zh: zh, en: en })
        }, 'dsh-task-brief: dictionaries')

        var t = (ctx.locale && typeof ctx.locale.bind === 'function')
          ? ctx.locale.bind(NS)
          : function (key) { return (zh[key] != null ? zh[key] : (en[key] != null ? en[key] : key)) }

        ctx.slots.inject('conversation.hero.options', function () {
          return ctx.slots.register({
            name: 'conversation.hero.options',
            id: 'dsh-task-brief',
            order: 20,
            locale: NS,
            label: function () { return t('hint') },
          }, function (props) {
            return h(TaskBriefHint, { t: t, ...props })
          })
        }, 'dsh-task-brief: hero hint')
      },
    }
  },
})
