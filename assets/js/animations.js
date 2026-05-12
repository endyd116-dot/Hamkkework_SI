/**
 * Scroll-reveal, counter, marquee, process path animations
 * Uses IntersectionObserver. Honors prefers-reduced-motion.
 */

const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/* ============================================================
   Generic IntersectionObserver-based reveal
   ============================================================ */
function setupReveals() {
  const targets = document.querySelectorAll('.reveal, .stagger, .reveal-left, .reveal-right, .reveal-scale');
  if (reducedMotion) {
    targets.forEach((el) => el.classList.add('in'));
    return;
  }
  const io = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          entry.target.classList.add('in');
          io.unobserve(entry.target);
        }
      }
    },
    { threshold: 0.18, rootMargin: '0px 0px -60px 0px' }
  );
  targets.forEach((el) => io.observe(el));
}

/* ============================================================
   Counter animation
   ============================================================ */
function setupCounters() {
  const targets = document.querySelectorAll('[data-count]');
  const io = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const el = entry.target;
        const target = parseFloat(el.dataset.count) || 0;
        const suffix = el.dataset.suffix || '';
        const dur = 1200;
        if (reducedMotion) {
          el.textContent = `${target}${suffix}`;
          io.unobserve(el);
          continue;
        }
        const start = performance.now();
        function tick(now) {
          const t = Math.min(1, (now - start) / dur);
          const eased = 1 - Math.pow(1 - t, 3);
          const value = Math.round(target * eased);
          el.textContent = `${value}${suffix}`;
          if (t < 1) requestAnimationFrame(tick);
          else el.classList.add('counter-on');
        }
        requestAnimationFrame(tick);
        io.unobserve(el);
      }
    },
    { threshold: 0.6 }
  );
  targets.forEach((el) => io.observe(el));
}

/* ============================================================
   Hero typing effect
   ============================================================ */
export function setupHeroType() {
  if (reducedMotion) return;
  const lines = [
    { line1: '대기업 SI 결과물,', accent: '1/2 가격', tail: '에. 그리고 AI까지.' },
    { line1: '외주 0%, 자체 풀스택.', accent: '같은 결과물', tail: ' 절반 가격에.' },
    { line1: '챗봇이 아닙니다.', accent: 'AI Core', tail: '를 시스템 안에 박아드립니다.' },
    { line1: '인도 후에도', accent: '6개월 무상 보증', tail: '. 폐업 잠적 없습니다.' },
  ];
  const l1El = document.getElementById('heroLine1');
  const l2El = document.getElementById('heroLine2');
  const tailEl = document.getElementById('heroLine2Tail');
  if (!l1El || !l2El || !tailEl) return;
  let idx = 0;

  function setLine(t) {
    l1El.textContent = t.line1;
    l2El.textContent = t.accent;
    tailEl.textContent = t.tail;
  }
  // Slow rotation
  setInterval(() => {
    idx = (idx + 1) % lines.length;
    const old1 = l1El.textContent;
    const target = lines[idx];
    // fade-out → swap → fade-in
    [l1El, l2El, tailEl].forEach((el) => (el.style.transition = 'opacity 300ms ease-out'));
    [l1El, l2El, tailEl].forEach((el) => (el.style.opacity = 0));
    setTimeout(() => {
      setLine(target);
      [l1El, l2El, tailEl].forEach((el) => (el.style.opacity = 1));
    }, 320);
  }, 6500);
}

/* ============================================================
   Card 3D tilt on hover (subtle)
   ============================================================ */
function setupTilt() {
  if (reducedMotion) return;
  if (matchMedia('(hover: none)').matches) return;
  document.querySelectorAll('.card, .metric').forEach((el) => {
    el.addEventListener('mousemove', (e) => {
      const rect = el.getBoundingClientRect();
      const x = (e.clientX - rect.left) / rect.width - 0.5;
      const y = (e.clientY - rect.top) / rect.height - 0.5;
      el.style.transform = `perspective(800px) rotateX(${y * -4}deg) rotateY(${x * 4}deg) translateY(-3px)`;
    });
    el.addEventListener('mouseleave', () => {
      el.style.transform = '';
    });
  });
}

/* ============================================================
   Public boot
   ============================================================ */
export function bootAnimations() {
  setupReveals();
  setupCounters();
  setupHeroType();
  setupTilt();
}

bootAnimations();
