window.__ModuleLoader__.load({
  id: 'example-2',
  factory: (_require) => {
    const module = { exports: {} }
    const exports = module.exports

    function apply() {
      return [
        'w-notes-panel bg-notes-accent text-notes-accent border-notes-accent/40',
        'notes-compact flex w-full rounded-lg p-2',
        'sm:w-notes-panel sm:notes-compact dark:bg-notes-accent/20',
        'shadow-sm ring-1 ring-notes-accent/30 transition-colors',
        'w-xl h-full min-h-screen max-w-[80ch]',
      ]
    }

    exports.apply = apply
    return module.exports
  },
})
// # sourceMappingURL=client.js.map
