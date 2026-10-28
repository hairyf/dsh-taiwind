window.__ModuleLoader__.load({
  id: 'example-1',
  factory: (_require) => {
    const module = { exports: {} }
    const exports = module.exports

    function apply() {
      return [
        'w-full w-xl w-[1234px] h-[1234px]',
        'flex items-center justify-between gap-2 p-4',
        'grid grid-cols-[repeat(3,minmax(0,1fr))] lg:grid-cols-6',
        'text-[13px] leading-tight tracking-wide uppercase',
        'md:w-1/2 dark:bg-slate-900 hover:bg-slate-800',
        'focus:outline-none focus-visible:ring-2 aria-[expanded=true]:rotate-180',
      ]
    }

    exports.apply = apply
    return module.exports
  },
})
// # sourceMappingURL=client.js.map
