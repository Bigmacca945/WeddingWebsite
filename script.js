/**
 * script.js  –  Laura & Cathan Wedding Website
 * Features:
 *  - Sticky / scroll-aware navigation with active section highlighting
 *  - Mobile hamburger menu toggle
 *  - Live countdown timer (target: 20 February 2027 NZT)
 *  - Scroll fade-in animations via IntersectionObserver
 *  - Back-to-top button
 */

// Enable progressive enhancement hooks for JS-only visual effects.
document.documentElement.classList.add('js-enabled');

/* ============================================================
   INVITE CODE GATE
   ============================================================ */
(function initInviteGate() {
  const ACCESS_CODE = '04151912';
  const STORAGE_KEY = 'weddingInviteUnlocked';

  const html = document.documentElement;
  const gate = document.getElementById('invite-gate');
  const form = document.getElementById('invite-form');
  const input = document.getElementById('invite-code');
  const error = document.getElementById('invite-error');

  if (!gate || !form || !input || !error) {
    return;
  }

  const isUnlocked = localStorage.getItem(STORAGE_KEY) === 'true';
  if (isUnlocked) {
    html.classList.remove('invite-locked');
    gate.setAttribute('hidden', '');
    return;
  }

  html.classList.add('invite-locked');
  input.focus();

  form.addEventListener('submit', event => {
    event.preventDefault();
    const enteredCode = input.value.trim();

    if (enteredCode === ACCESS_CODE) {
      localStorage.setItem(STORAGE_KEY, 'true');
      html.classList.remove('invite-locked');
      gate.setAttribute('hidden', '');
      error.hidden = true;
      input.value = '';
      return;
    }

    error.hidden = false;
    input.select();
  });
}());

/* ============================================================
   UTILITY
   ============================================================ */

/**
 * Pad a number to at least two digits.
 * @param {number} n
 * @returns {string}
 */
function pad(n) {
  return String(n).padStart(2, '0');
}

/* ============================================================
   NAVIGATION – Sticky + active section highlight
   ============================================================ */
(function initNav() {
  const navbar   = document.getElementById('navbar');
  const navLinks = document.querySelectorAll('.nav-links a[href^="#"]');
  const sections = Array.from(document.querySelectorAll('section[id], footer[id]'));

  /** Apply/remove the scrolled class for the nav background */
  function onScroll() {
    if (window.scrollY > 60) {
      navbar.classList.add('scrolled');
    } else {
      navbar.classList.remove('scrolled');
    }

    updateActiveLink();
    if (typeof window.toggleBackToTop === 'function') {
      window.toggleBackToTop();
    }
  }

  /** Highlight the nav link whose section is most in view */
  function updateActiveLink() {
    let currentId = '';
    const offset = 90; // navbar height + buffer

    sections.forEach(section => {
      const top = section.getBoundingClientRect().top;
      if (top <= offset) {
        currentId = section.id;
      }
    });

    navLinks.forEach(link => {
      link.classList.remove('active');
      if (link.getAttribute('href') === `#${currentId}`) {
        link.classList.add('active');
      }
    });
  }

  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll(); // run once on load
}());

/* ============================================================
   HAMBURGER MENU
   ============================================================ */
(function initHamburger() {
  const hamburger  = document.getElementById('hamburger');
  const navLinksEl = document.getElementById('nav-links');

  hamburger.addEventListener('click', () => {
    const isOpen = hamburger.classList.toggle('open');
    hamburger.setAttribute('aria-expanded', String(isOpen));
    navLinksEl.classList.toggle('open', isOpen);
    // Prevent body scroll when menu is open
    document.body.style.overflow = isOpen ? 'hidden' : '';
  });

  // Close menu when a link is clicked
  navLinksEl.querySelectorAll('a').forEach(link => {
    link.addEventListener('click', () => {
      hamburger.classList.remove('open');
      hamburger.setAttribute('aria-expanded', 'false');
      navLinksEl.classList.remove('open');
      document.body.style.overflow = '';
    });
  });

  // Close on Escape key
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && hamburger.classList.contains('open')) {
      hamburger.classList.remove('open');
      hamburger.setAttribute('aria-expanded', 'false');
      navLinksEl.classList.remove('open');
      document.body.style.overflow = '';
      hamburger.focus();
    }
  });
}());

/* ============================================================
   COUNTDOWN TIMER
   Target: 20 February 2027 12:00:00 NZDT (UTC+13)
   ============================================================ */
(function initCountdown() {
  // Wedding date in NZ Daylight Time (UTC+13 in February)
  const WEDDING_DATE = new Date('2027-02-20T12:00:00+13:00');

  const daysEl    = document.getElementById('cd-days');
  const hoursEl   = document.getElementById('cd-hours');
  const minutesEl = document.getElementById('cd-minutes');
  const secondsEl = document.getElementById('cd-seconds');

  if (!daysEl || !hoursEl || !minutesEl || !secondsEl) {
    return;
  }

  function tick() {
    const now  = new Date();
    const diff = WEDDING_DATE - now;

    if (diff <= 0) {
      // Wedding day has arrived!
      daysEl.textContent    = '00';
      hoursEl.textContent   = '00';
      minutesEl.textContent = '00';
      secondsEl.textContent = '00';
      return;
    }

    const totalSeconds = Math.floor(diff / 1000);
    const days         = Math.floor(totalSeconds / 86400);
    const hours        = Math.floor((totalSeconds % 86400) / 3600);
    const minutes      = Math.floor((totalSeconds % 3600) / 60);
    const seconds      = totalSeconds % 60;

    daysEl.textContent    = pad(days);
    hoursEl.textContent   = pad(hours);
    minutesEl.textContent = pad(minutes);
    secondsEl.textContent = pad(seconds);
  }

  tick(); // immediate first render
  setInterval(tick, 1000);
}());

/* ============================================================
   SCROLL FADE-IN  (IntersectionObserver)
   ============================================================ */
(function initFadeIn() {
  const root = document.documentElement;
  const fadeEls = document.querySelectorAll('.fade-in');

  // Fallback for older mobile browsers: keep content visible.
  if (typeof window.IntersectionObserver !== 'function') {
    fadeEls.forEach(el => el.classList.add('visible'));
    return;
  }

  root.classList.add('fade-init');

  // Add 'visible' class when elements enter the viewport
  const observer = new IntersectionObserver(
    entries => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          entry.target.classList.add('visible');
          observer.unobserve(entry.target); // animate once only
        }
      });
    },
    { threshold: 0.12 }
  );

  fadeEls.forEach(el => {
    // Only observe if the element is NOT already in the viewport on page load
    const rect = el.getBoundingClientRect();
    if (rect.top < window.innerHeight) {
      el.classList.add('visible'); // already visible – show immediately
    } else {
      observer.observe(el);
    }
  });
}());

/* ============================================================
   BACK TO TOP BUTTON
   ============================================================ */
function toggleBackToTop() {
    const button = document.getElementById("back-to-top");

    if (!button) return;

    if (window.scrollY > 300) {
        button.style.display = "block";
    } else {
        button.style.display = "none";
    }
}

/**
 * toggleBackToTop is called from the scroll event added in initNav.
 * The window property is set in initBackToTop above; the reference is safe
 * because initNav's onScroll runs after the DOM is ready.
 */

/* ============================================================
   RSVP FORM
   ============================================================ */
(function initRsvpForm() {
  const form = document.getElementById('rsvp-form');

  if (!form) {
    return;
  }

  const submitButton = document.getElementById('rsvp-submit');
  const submitLabel = submitButton.querySelector('.submit-label');
  const submitLoading = submitButton.querySelector('.submit-loading');
  const successMessage = document.getElementById('rsvp-success');
  const formError = document.getElementById('form-error');
  const guestNamesField = document.getElementById('guest-names-field');
  const guestNames = document.getElementById('guest-names');
  const attendanceInputs = form.querySelectorAll('input[name="attendance"]');

  function getAttendance() {
    return form.querySelector('input[name="attendance"]:checked')?.value || '';
  }

  function setFieldError(field, message) {
    const errorId = field.getAttribute('aria-describedby')?.split(' ').find(id => id.endsWith('-error'));
    const error = errorId ? document.getElementById(errorId) : null;
    field.classList.toggle('is-invalid', Boolean(message));
    field.setAttribute('aria-invalid', String(Boolean(message)));

    if (error) {
      error.textContent = message;
    }
  }

  function validateField(field) {
    let message = '';

    if (field.required && !field.value.trim()) {
      message = 'Please complete this required field.';
    }

    setFieldError(field, message);
    return !message;
  }

  function validateAttendance(showError) {
    const isValid = Boolean(getAttendance());
    const error = document.getElementById('attendance-error');

    attendanceInputs.forEach(input => input.setAttribute('aria-invalid', String(!isValid)));
    if (showError) {
      error.textContent = isValid ? '' : 'Please let us know if you will be attending.';
    }

    return isValid;
  }

  function updateGuestNames() {
    const isAttending = getAttendance() === 'Joyfully Accepts';
    guestNamesField.hidden = !isAttending;
    guestNames.required = isAttending;

    if (!isAttending) {
      guestNames.value = '';
      setFieldError(guestNames, '');
    }
  }

  function isFormComplete() {
    const requiredFields = Array.from(form.querySelectorAll('input[required]:not([type="radio"]), select[required], textarea[required]'));
    return validateAttendance(false) && requiredFields.every(field => field.value.trim());
  }

  function updateSubmitState() {
    submitButton.disabled = !isFormComplete();
  }

  form.querySelectorAll('input, select, textarea').forEach(field => {
    field.addEventListener('input', updateSubmitState);
    field.addEventListener('change', updateSubmitState);

    if (field.required && field.type !== 'radio') {
      field.addEventListener('blur', () => validateField(field));
    }
  });

  attendanceInputs.forEach(input => {
    input.addEventListener('change', () => {
      updateGuestNames();
      validateAttendance(true);
      updateSubmitState();
    });
  });

  form.addEventListener('submit', async event => {
    event.preventDefault();
    const requiredFields = Array.from(form.querySelectorAll('input[required]:not([type="radio"]), select[required], textarea[required]'));
    const fieldsAreValid = requiredFields.every(field => validateField(field));
    const attendanceIsValid = validateAttendance(true);

    if (!fieldsAreValid || !attendanceIsValid) {
      form.querySelector('[aria-invalid="true"]')?.focus();
      updateSubmitState();
      return;
    }

    submitButton.disabled = true;
    submitLabel.hidden = true;
    submitLoading.hidden = false;
    form.setAttribute('aria-busy', 'true');
    formError.hidden = true;

    try {
      const endpoint = form.action;

      // Demo locally until YOUR_FORM_ID in rsvp.html is replaced with a Formspree form ID.
      if (endpoint.includes('YOUR_FORM_ID')) {
        await new Promise(resolve => setTimeout(resolve, 800));
      } else {
        const response = await fetch(endpoint, {
          method: 'POST',
          body: new FormData(form),
          headers: { Accept: 'application/json' }
        });

        if (!response.ok) {
          throw new Error('Form submission failed');
        }
      }

      form.hidden = true;
      successMessage.hidden = false;
      successMessage.focus();
    } catch (error) {
      formError.textContent = 'We could not send your RSVP. Please check your connection and try again.';
      formError.hidden = false;
      submitButton.disabled = false;
    } finally {
      form.removeAttribute('aria-busy');
      submitLabel.hidden = false;
      submitLoading.hidden = true;
    }
  });

  updateGuestNames();
  updateSubmitState();
}());
