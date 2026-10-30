import React, { useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { QRCodeSVG } from 'qrcode.react';
import { FEATURE_REGISTRY } from '@/lib/featureRegistry';
import { SUPPORT_EMAIL, WHATS_NEW, CLIENTS } from '@/lib/siteContent';
import './HomePage.css';

// Icons for every entry in FEATURE_REGISTRY — kept here (rather than in the
// registry itself) since this page is the only consumer that needs per-item
// icons; Toggle Services just needs the name/description/category.
const FEATURE_ICONS = {
  employees: 'fa-users', attendance: 'fa-fingerprint', shift_roster: 'fa-calendar-days',
  employee_calendar: 'fa-calendar-alt', late_comers_report: 'fa-clock', master_report: 'fa-file-alt', helpdesk: 'fa-headset',
  announcements: 'fa-bullhorn', policies: 'fa-file-contract', onboarding: 'fa-door-open',
  offboarding: 'fa-door-closed', training: 'fa-graduation-cap', assets: 'fa-laptop',
  projects: 'fa-diagram-project', grievances: 'fa-gavel', outlets_multi_branch: 'fa-store',
  leave_requests: 'fa-calendar-minus', regularize_attendance: 'fa-clock-rotate-left',
  wfh_requests: 'fa-house-laptop', special_requests: 'fa-inbox', expense_claims: 'fa-receipt',
  travel_requests: 'fa-plane', leave_setup: 'fa-sliders', tax_declaration: 'fa-file-invoice',
  hiring: 'fa-briefcase', headcount_requests: 'fa-user-plus', interviews: 'fa-comments',
  offer_letters: 'fa-file-signature', refer: 'fa-share-nodes',
  performance_kras: 'fa-bullseye', performance_one_on_ones: 'fa-people-arrows',
  performance_feedback: 'fa-comment-dots', performance_pip: 'fa-chart-line', performance_reviews: 'fa-star',
  salary_structure: 'fa-sitemap', run_payroll: 'fa-money-bill-wave', payslips: 'fa-file-invoice-dollar',
  advances_loans: 'fa-hand-holding-dollar', salary_additions: 'fa-coins', tax_slabs: 'fa-percent',
  approval_chains: 'fa-route',
  tasks: 'fa-list-check', task_reminders: 'fa-bell', org_hierarchy: 'fa-sitemap',
  profile_verification: 'fa-id-card', careers_page: 'fa-globe', recruitment_pipeline: 'fa-filter',
  geofencing: 'fa-location-crosshairs', live_tracking: 'fa-location-dot',
  ai_assistant: 'fa-robot', ai_meetings: 'fa-microphone-lines',
};

const CATEGORY_META = {
  General:     { icon: 'fa-layer-group',   blurb: 'The everyday tools every company gets' },
  Requests:    { icon: 'fa-inbox',         blurb: 'Employee-initiated requests and approvals' },
  Hiring:      { icon: 'fa-briefcase',     blurb: 'From job posting to signed offer letter' },
  Performance: { icon: 'fa-trophy',        blurb: 'Goals, feedback, and review cycles' },
  Payroll:     { icon: 'fa-wallet',        blurb: 'Salary structure through payslip delivery' },
  System:      { icon: 'fa-gears',         blurb: 'Configuration that powers everything else' },
  Premium:     { icon: 'fa-gem',           blurb: 'Add-ons you can switch on per company' },
};

const CATEGORY_ORDER = ['General', 'Requests', 'Hiring', 'Performance', 'Payroll', 'System', 'Premium'];

const FEATURE_CATEGORIES = CATEGORY_ORDER.map((category) => ({
  category,
  ...CATEGORY_META[category],
  items: FEATURE_REGISTRY
    .filter((f) => f.category === category)
    .sort((a, b) => a.sort_order - b.sort_order),
})).filter((c) => c.items.length);

// Icon tints for the "What's new" cards, cycled in order — purely decorative.
const TONES = ['iris', 'aqua', 'violet', 'amber', 'emerald', 'sky', 'rose', 'indigo'];

// Fades sections in as they scroll into view. Content is fully visible without
// JS / with reduced motion — the hidden state only applies once this runs.
function useScrollReveal(rootRef) {
  useEffect(() => {
    const root = rootRef.current;
    if (!root || typeof IntersectionObserver === 'undefined') return undefined;
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return undefined;
    const els = root.querySelectorAll('.reveal');
    const io = new IntersectionObserver((entries) => {
      entries.forEach((e) => {
        if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); }
      });
    }, { rootMargin: '0px 0px -8% 0px', threshold: 0.08 });
    root.classList.add('reveal-ready');
    els.forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, [rootRef]);
}

// Decorative product illustration for the hero — abstract shapes only, no copy.
function HeroVisual() {
  return (
    <div className="hero-visual" aria-hidden="true">
      <div className="hv-window">
        <div className="hv-bar"><span /><span /><span /></div>
        <div className="hv-body">
          <div className="hv-side">
            <i className="fas fa-house" /><i className="fas fa-users" /><i className="fas fa-fingerprint" />
            <i className="fas fa-wallet" /><i className="fas fa-list-check" /><i className="fas fa-chart-line" />
          </div>
          <div className="hv-main">
            <div className="hv-tiles">
              <div className="hv-tile"><i className="fas fa-user-check t-emerald" /><b style={{ width: '58%' }} /><em /></div>
              <div className="hv-tile"><i className="fas fa-calendar-check t-iris" /><b style={{ width: '42%' }} /><em /></div>
              <div className="hv-tile"><i className="fas fa-indian-rupee-sign t-amber" /><b style={{ width: '66%' }} /><em /></div>
            </div>
            <div className="hv-panels">
              <div className="hv-chart">
                {[46, 64, 52, 78, 60, 88, 72].map((h, i) => <span key={i} style={{ height: `${h}%` }} />)}
              </div>
              <div className="hv-ring">
                <svg viewBox="0 0 80 80"><circle cx="40" cy="40" r="30" /><circle cx="40" cy="40" r="30" className="hv-ring-val" /></svg>
              </div>
            </div>
            <div className="hv-rows">
              {[72, 54, 63].map((w, i) => (
                <div className="hv-row" key={i}><span className="hv-avatar" /><b style={{ width: `${w}%` }} /><span className="hv-chip" /></div>
              ))}
            </div>
          </div>
        </div>
      </div>
      <div className="hv-float f1"><i className="fas fa-fingerprint" /></div>
      <div className="hv-float f2"><i className="fas fa-robot" /></div>
      <div className="hv-float f3"><i className="fas fa-file-invoice-dollar" /></div>
    </div>
  );
}

export default function HomePage() {
  const navigate = useNavigate();
  const rootRef = useRef(null);
  useScrollReveal(rootRef);

  return (
    <div className="homepage lp" ref={rootRef}>
      {/* Navigation */}
      <nav className="navbar">
        <div className="container">
          <div className="navbar-content">
            <div className="navbar-left">
              <div className="logo">
                <img src="/logo.png" alt="CrewCore" />
                <span>CrewCore</span>
              </div>
              <div className="nav-links">
                <a href="#whats-new">What's New</a>
                <a href="#features">Features</a>
                <a href="/erp" onClick={(e) => { e.preventDefault(); navigate('/erp'); }}>ERP <span className="soon-pill">Soon</span></a>
                <a href="#support">Support</a>
              </div>
            </div>
            <div className="nav-buttons">
              <button className="btn-secondary" onClick={() => navigate('/login')}>
                Sign In
              </button>
              <button className="btn-primary" onClick={() => navigate('/signup')}>
                Register Company
              </button>
            </div>
          </div>
        </div>
      </nav>

      {/* Hero Section */}
      <section className="hero hero-split">
        <div className="hero-bg" aria-hidden="true"><span className="blob b1" /><span className="blob b2" /><span className="grid" /></div>
        <div className="container">
          <div className="hero-grid">
            <div className="hero-inner">
              <span className="eyebrow">HR, Payroll &amp; Workforce Platform</span>
              <h1>
                Run your workforce.<br />
                <span className="accent">Not the paperwork.</span>
              </h1>
              <p>
                CrewCore brings your team, attendance, leave, payroll, tasks, performance and hiring
                together in one platform — with an AI assistant built in — for businesses that would
                rather move than manage spreadsheets.
              </p>
              <div className="hero-buttons">
                <button className="btn-primary btn-lg" onClick={() => navigate('/signup')}>
                  Register Your Company
                </button>
                <button className="btn-outline btn-lg" onClick={() => navigate('/login')}>
                  Sign In
                </button>
              </div>
              <div className="hero-stats">
                <div className="hero-stat">
                  <strong>{FEATURE_REGISTRY.length}+</strong>
                  <span>modules included</span>
                </div>
                <div className="hero-stat">
                  <strong>Multi-tenant</strong>
                  <span>isolated by design</span>
                </div>
                <div className="hero-stat">
                  <strong>Role-based</strong>
                  <span>access control</span>
                </div>
              </div>
            </div>
            <HeroVisual />
          </div>
        </div>
      </section>

      {/* Trusted by (only when CLIENTS has entries) */}
      {CLIENTS.length > 0 && (
        <section className="clients-strip">
          <div className="container">
            <p className="clients-title">Trusted by growing teams</p>
            <div className="clients-row">
              {CLIENTS.map((c) => (
                <div className="client-item" key={c.name} title={c.sector || c.name}>
                  {c.logo ? <img src={c.logo} alt={c.name} /> : <span>{c.name}</span>}
                </div>
              ))}
            </div>
          </div>
        </section>
      )}

      {/* What's new */}
      <section className="features whats-new" id="whats-new">
        <div className="container">
          <div className="section-header reveal">
            <span className="eyebrow">New in CrewCore</span>
            <h2>More than payroll — run the whole workday</h2>
            <p>Tasks, AI, performance and hiring, built into the same HR system your team already uses</p>
          </div>
          <div className="features-grid whats-new-grid">
            {WHATS_NEW.map((f, i) => (
              <div className={`feature-card reveal tone-${TONES[i % TONES.length]}`} key={f.title} style={{ '--d': `${(i % 4) * 60}ms` }}>
                {f.badge && <span className="feature-index new-badge">{f.badge}</span>}
                <i className={`fas ${f.icon} feature-icon`}></i>
                <h3>{f.title}</h3>
                <p>{f.text}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Features Section */}
      <section className="features" id="features">
        <div className="container">
          <div className="section-header reveal">
            <h2>Built around how HR teams actually work</h2>
            <p>The daily-use core, with the full catalog below for everything else</p>
          </div>
          
          <div className="features-grid core-grid">
            <div className="feature-card reveal">
              <span className="feature-index">01</span>
              <i className="fas fa-users feature-icon"></i>
              <h3>Employee Management</h3>
              <p>Organize and manage all employee information in one centralized system</p>
            </div>

            <div className="feature-card reveal">
              <span className="feature-index">02</span>
              <i className="fas fa-clock feature-icon"></i>
              <h3>Attendance Tracking</h3>
              <p>Track attendance and time off with automated, real-time logging</p>
            </div>

            <div className="feature-card reveal">
              <span className="feature-index">03</span>
              <i className="fas fa-calendar-alt feature-icon"></i>
              <h3>Leave Management</h3>
              <p>Handle leave requests and approvals seamlessly with our workflow</p>
            </div>

            <div className="feature-card reveal">
              <span className="feature-index">04</span>
              <i className="fas fa-money-bill feature-icon"></i>
              <h3>Salary Management</h3>
              <p>Process salaries accurately and generate payslips automatically</p>
            </div>

            <div className="feature-card reveal">
              <span className="feature-index">05</span>
              <i className="fas fa-receipt feature-icon"></i>
              <h3>Payroll Processing</h3>
              <p>Automate payroll calculations with customizable policies</p>
            </div>

            <div className="feature-card reveal">
              <span className="feature-index">06</span>
              <i className="fas fa-file-invoice feature-icon"></i>
              <h3>Payslip Generation</h3>
              <p>Generate and distribute digital payslips instantly to employees</p>
            </div>
          </div>
        </div>
      </section>

      {/* Full feature catalog, grouped exactly like the in-app Toggle Services list */}
      <section className="all-features">
        <div className="container">
          <div className="section-header reveal">
            <h2>Everything CrewCore Includes</h2>
            <p>One platform covering the entire employee lifecycle — no add-ons, no separate tools</p>
          </div>

          <div className="feature-category-grid">
            {FEATURE_CATEGORIES.map((cat) => (
              <div className={`feature-category-card reveal${cat.items.length > 10 ? ' wide' : ''}`} key={cat.category}>
                <div className="feature-category-header">
                  <div className="feature-category-icon"><i className={`fas ${cat.icon}`}></i></div>
                  <div>
                    <h3>{cat.category} <span className="feature-count">{cat.items.length}</span></h3>
                    <p>{cat.blurb}</p>
                  </div>
                </div>
                <ul className="feature-item-list">
                  {cat.items.map((item) => (
                    <li key={item.key}>
                      <i className={`fas ${FEATURE_ICONS[item.key] || 'fa-check'}`}></i>
                      <span>{item.name}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Benefits Section */}
      <section className="benefits">
        <div className="container">
          <div className="benefits-content reveal">
            <div className="benefits-text">
              <h2>Why Choose CrewCore?</h2>
              <ul className="benefits-list">
                <li>
                  <span className="check"><i className="fas fa-check"></i></span>
                  <span>Multi-tenant architecture for complete data isolation</span>
                </li>
                <li>
                  <span className="check"><i className="fas fa-check"></i></span>
                  <span>Role-based access control for security</span>
                </li>
                <li>
                  <span className="check"><i className="fas fa-check"></i></span>
                  <span>Intuitive dashboard with real-time insights</span>
                </li>
                <li>
                  <span className="check"><i className="fas fa-check"></i></span>
                  <span>Automated workflows to save time</span>
                </li>
                <li>
                  <span className="check"><i className="fas fa-check"></i></span>
                  <span>Comprehensive reporting and analytics</span>
                </li>
                <li>
                  <span className="check"><i className="fas fa-check"></i></span>
                  <span>24/7 reliable service with cloud infrastructure</span>
                </li>
              </ul>
            </div>
          </div>
        </div>
      </section>

      {/* ERP teaser */}
      <section className="erp-teaser">
        <div className="container">
          <div className="erp-teaser-card reveal">
            <div>
              <span className="soon-pill">Coming soon</span>
              <h2>CrewCore ERP</h2>
              <p>Inventory, purchase, GST invoicing, accounts and CRM — connected to the HR and payroll you already run on CrewCore.</p>
            </div>
            <button className="btn-primary btn-lg" onClick={() => navigate('/erp')}>See what's coming</button>
          </div>
        </div>
      </section>

      {/* Mobile App Section */}
      <section className="app-download">
        <div className="container">
          <div className="app-download-content reveal">
            <div className="app-download-text">
              <h2>Take CrewCore With You</h2>
              <p>
                Clock in, check payslips, and manage leave requests on the go with the
                CrewCore mobile app — free to download on the Google Play Store.
              </p>
              <a
                className="play-badge"
                href="https://play.google.com/store/apps/details?id=com.crewcore.app"
                target="_blank"
                rel="noopener noreferrer"
              >
                <i className="fab fa-google-play"></i>
                <span>
                  <small>GET IT ON</small>
                  Google Play
                </span>
              </a>
            </div>
            <div className="app-download-qr">
              <QRCodeSVG
                value="https://play.google.com/store/apps/details?id=com.crewcore.app"
                size={168}
                bgColor="#ffffff"
                fgColor="#1E293B"
                level="M"
              />
              <p>Scan to download</p>
            </div>
          </div>
        </div>
      </section>

      {/* Support Section */}
      <section className="support" id="support">
        <div className="container">
          <div className="support-card reveal">
            <div className="support-icon"><i className="fas fa-headset"></i></div>
            <div className="support-text">
              <h2>Need a hand?</h2>
              <p>Our support team replies to every email — whether it's a question about setting up your company, a billing query, or something not working the way it should.</p>
            </div>
            <a className="btn-primary btn-lg" href={`mailto:${SUPPORT_EMAIL}`}>
              <i className="fas fa-envelope"></i> {SUPPORT_EMAIL}
            </a>
          </div>
        </div>
      </section>

      {/* CTA Section */}
      <section className="cta">
        <div className="container">
          <div className="cta-content reveal">
            <h2>Set your company up in minutes</h2>
            <p>No add-ons, no separate tools to wire together — register and start today</p>
            <button className="btn-primary btn-lg" onClick={() => navigate('/signup')}>
              Register Your Company
            </button>
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="footer">
        <div className="container">
          <div className="footer-content">
            <div className="footer-section footer-brand">
              <h4><img src="/logo.png" alt="" />CrewCore</h4>
              <p>HR, payroll, tasks and performance for growing Indian businesses</p>
            </div>
            <div className="footer-section">
              <h4>Product</h4>
              <ul>
                <li><a href="#whats-new">What's New</a></li>
                <li><a href="#features">Features</a></li>
                <li><a href="/erp" onClick={(e) => { e.preventDefault(); navigate('/erp'); }}>ERP (coming soon)</a></li>
              </ul>
            </div>
            <div className="footer-section">
              <h4>Company</h4>
              <ul>
                <li><a href="#features">About</a></li>
                <li><a href={`mailto:${SUPPORT_EMAIL}`}>Contact</a></li>
              </ul>
            </div>
            <div className="footer-section">
              <h4>Support</h4>
              <ul>
                <li><a href={`mailto:${SUPPORT_EMAIL}`}><i className="fas fa-envelope" style={{ marginRight: 8 }}></i>{SUPPORT_EMAIL}</a></li>
              </ul>
            </div>
          </div>
          <div className="footer-bottom">
            <p>&copy; 2026 CrewCore. All rights reserved.</p>
          </div>
        </div>
      </footer>
    </div>
  );
}
