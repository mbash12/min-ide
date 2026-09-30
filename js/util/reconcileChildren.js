// Keep unchanged row nodes attached so focus, selection and scroll survive
// refreshes. Callers decide which records need new nodes.
module.exports = function reconcileChildren (parent, desired) {
  const retained = new Set(desired)
  Array.from(parent.children).forEach(child => {
    if (!retained.has(child)) parent.removeChild(child)
  })
  desired.forEach((child, index) => {
    if (parent.children[index] !== child) parent.insertBefore(child, parent.children[index] || null)
  })
}
