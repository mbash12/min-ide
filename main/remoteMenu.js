ipc.on('open-context-menu', function (e, data) {
  var menu = new Menu()

  data.template.forEach(function (section, index) {
    section.forEach(function (item) {
      var id = item.click
      item.click = function () {
        e.sender.send('context-menu-item-selected', { menuId: data.id, itemId: id })
      }
      if (item.submenu) {
        for (var i = 0; i < item.submenu.length; i++) {
          (function (id) {
            item.submenu[i].click = function () {
              e.sender.send('context-menu-item-selected', { menuId: data.id, itemId: id })
            }
          })(item.submenu[i].click)
        }
      }
      menu.append(new MenuItem(item))
    })
    // sections are divided, but the last one should not leave a dangling
    // separator at the bottom of the menu
    if (index < data.template.length - 1) {
      menu.append(new MenuItem({ type: 'separator' }))
    }
  })
  menu.on('menu-will-close', function () {
    e.sender.send('context-menu-will-close', { menuId: data.id })
  })
  menu.popup({ x: data.x, y: data.y })
})
