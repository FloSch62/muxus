/* Landing page hero behaviour. Two small things, both optional:
   - pause the background animations while the hero is scrolled out of view, so
     reading the rest of the page costs nothing on the compositor;
   - a gentle pointer parallax on desktop, applied as plain transforms on three
     wrapper elements (the panes keep their own compositor animations underneath).
   Re-runs on every instant navigation through document$. */
(function () {
  var teardown = null;

  function setup() {
    if (teardown) {
      teardown();
      teardown = null;
    }
    var hero = document.querySelector('.muxus-hero');
    if (!hero) return;

    var cleanups = [];

    if ('IntersectionObserver' in window) {
      var io = new IntersectionObserver(
        function (entries) {
          hero.classList.toggle('muxus-hero--idle', !entries[0].isIntersecting);
        },
        { threshold: 0 }
      );
      io.observe(hero);
      cleanups.push(function () {
        io.disconnect();
      });
    }

    var reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    var fine = window.matchMedia('(pointer: fine)').matches;
    var scene = hero.querySelector('.muxus-hero__scene');
    var far = hero.querySelector('.muxus-hero__layer--far');
    var glows = hero.querySelector('.muxus-hero__glows');
    if (!reduced && fine && scene && far && glows) {
      var target = { x: 0, y: 0 };
      var current = { x: 0, y: 0 };
      var frame = 0;

      var step = function () {
        frame = 0;
        current.x += (target.x - current.x) * 0.08;
        current.y += (target.y - current.y) * 0.08;
        var x = current.x;
        var y = current.y;
        scene.style.transform = 'translate3d(' + (x * 10).toFixed(2) + 'px,' + (y * 10).toFixed(2) + 'px,0)';
        far.style.transform = 'translate3d(' + (x * -6).toFixed(2) + 'px,' + (y * -6).toFixed(2) + 'px,0)';
        glows.style.transform = 'translate3d(' + (x * -18).toFixed(2) + 'px,' + (y * -18).toFixed(2) + 'px,0)';
        if (Math.abs(target.x - x) > 0.002 || Math.abs(target.y - y) > 0.002) {
          frame = requestAnimationFrame(step);
        }
      };
      var schedule = function () {
        if (!frame) frame = requestAnimationFrame(step);
      };
      var onMove = function (event) {
        var rect = hero.getBoundingClientRect();
        target.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
        target.y = ((event.clientY - rect.top) / rect.height) * 2 - 1;
        schedule();
      };
      var onLeave = function () {
        target.x = 0;
        target.y = 0;
        schedule();
      };
      hero.addEventListener('pointermove', onMove, { passive: true });
      hero.addEventListener('pointerleave', onLeave, { passive: true });
      cleanups.push(function () {
        hero.removeEventListener('pointermove', onMove);
        hero.removeEventListener('pointerleave', onLeave);
        if (frame) cancelAnimationFrame(frame);
      });
    }

    teardown = function () {
      cleanups.forEach(function (fn) {
        fn();
      });
    };
  }

  if (window.document$ && typeof window.document$.subscribe === 'function') {
    window.document$.subscribe(setup);
  } else if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', setup);
  } else {
    setup();
  }
})();
