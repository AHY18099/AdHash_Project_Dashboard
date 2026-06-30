import React from 'react';

const PILL_STYLES = {
  'No Tests':        { bg: 'bg-slate-100',   text: 'text-slate-500',   border: 'border-slate-200',  dot: 'bg-slate-400'   },
  'Not Started':     { bg: 'bg-slate-100',   text: 'text-slate-500',   border: 'border-slate-200',  dot: 'bg-slate-400'   },
  'Release Ready':   { bg: 'bg-emerald-50',  text: 'text-emerald-700', border: 'border-emerald-200',dot: 'bg-emerald-500' },
  'In Progress':     { bg: 'bg-blue-50',     text: 'text-blue-700',    border: 'border-blue-200',   dot: 'bg-blue-500'    },
  'Failed':          { bg: 'bg-red-50',      text: 'text-red-700',     border: 'border-red-200',    dot: 'bg-red-500'     },
};

function getStatusStyle(testStatus = '') {
  const key = Object.keys(PILL_STYLES).find(k =>
    testStatus.toLowerCase().includes(k.toLowerCase())
  );
  return PILL_STYLES[key] || PILL_STYLES['Not Started'];
}

export function ProjectCard({ name, description, logo, accentColor = '#6366f1', testStatus = '— No Tests', href = '#' }) {
  const style = getStatusStyle(testStatus);

  return (
    <a
      href={href}
      className="group block bg-white rounded-2xl shadow-sm border border-slate-100 overflow-hidden
                 transition-all duration-200 ease-out
                 hover:shadow-lg hover:-translate-y-1 hover:border-slate-200
                 focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2"
      style={{ '--accent': accentColor }}
    >
      {/* Colored top border */}
      <div
        className="h-1 w-full flex-shrink-0"
        style={{ background: `linear-gradient(90deg, ${accentColor}, ${accentColor}99)` }}
      />

      {/* Card body */}
      <div className="p-5 flex flex-col gap-0 h-full">
        {/* Logo + name + description */}
        <div className="flex items-start gap-3 mb-4">
          {/* Avatar */}
          <div
            className="w-11 h-11 rounded-xl flex items-center justify-center flex-shrink-0
                       transition-transform duration-200 group-hover:scale-105"
            style={{ background: `${accentColor}18`, border: `1.5px solid ${accentColor}33` }}
          >
            {typeof logo === 'string' && logo.startsWith('http') ? (
              <img
                src={logo}
                alt={name}
                className="w-7 h-7 rounded-md object-contain"
                onError={e => { e.target.style.display = 'none'; e.target.nextSibling.style.display = 'block'; }}
              />
            ) : null}
            <span className="text-xl" style={{ display: typeof logo === 'string' && logo.startsWith('http') ? 'none' : 'block' }}>
              {typeof logo === 'string' && !logo.startsWith('http') ? logo : '📁'}
            </span>
          </div>

          {/* Name + description */}
          <div className="flex-1 min-w-0">
            <h3 className="text-[15px] font-extrabold text-slate-800 leading-tight tracking-tight truncate">
              {name}
            </h3>
            {description && (
              <p
                className="text-[12px] text-slate-400 leading-snug mt-0.5"
                style={{
                  display: '-webkit-box',
                  WebkitLineClamp: 2,
                  WebkitBoxOrient: 'vertical',
                  overflow: 'hidden',
                }}
              >
                {description}
              </p>
            )}
          </div>
        </div>

        {/* Spacer */}
        <div className="flex-1" />

        {/* Footer */}
        <div className="flex items-center justify-between pt-3 border-t border-slate-100">
          {/* Test status pill */}
          <span
            className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full
                        text-[11px] font-semibold border
                        ${style.bg} ${style.text} ${style.border}`}
          >
            <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${style.dot}`} />
            {testStatus}
          </span>

          {/* Arrow button */}
          <div
            className="w-7 h-7 rounded-full border border-slate-200 flex items-center justify-center
                       text-slate-400 text-sm font-bold
                       transition-all duration-200
                       group-hover:border-transparent group-hover:text-white"
            style={{
              transition: 'background 0.2s, color 0.2s, border-color 0.2s',
            }}
            onMouseEnter={e => {
              e.currentTarget.style.background = accentColor;
              e.currentTarget.style.borderColor = 'transparent';
              e.currentTarget.style.color = '#fff';
            }}
            onMouseLeave={e => {
              e.currentTarget.style.background = '';
              e.currentTarget.style.borderColor = '';
              e.currentTarget.style.color = '';
            }}
          >
            →
          </div>
        </div>
      </div>
    </a>
  );
}
