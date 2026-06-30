import React from 'react';
import { ProjectCard } from './ProjectCard';

/**
 * ProjectGrid
 *
 * Props:
 *   projects: Array<{
 *     id: string,
 *     name: string,
 *     description: string,
 *     logo: string,          // URL (https://...) for favicon, or emoji string
 *     accentColor: string,   // hex e.g. "#6366f1"
 *     testStatus: string,    // e.g. "— No Tests", "✓ Release Ready", "◌ 62% In Progress"
 *     href: string,          // navigation target
 *   }>
 */
export function ProjectGrid({ projects = [] }) {
  if (!projects.length) {
    return (
      <div className="flex flex-col items-center justify-center py-20 text-slate-400">
        <span className="text-4xl mb-3">📁</span>
        <p className="text-sm font-medium">No projects yet</p>
      </div>
    );
  }

  return (
    <div
      className="grid gap-4"
      style={{
        gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))',
      }}
    >
      {projects.map(proj => (
        <ProjectCard
          key={proj.id}
          name={proj.name}
          description={proj.description}
          logo={proj.logo}
          accentColor={proj.accentColor}
          testStatus={proj.testStatus}
          href={proj.href}
        />
      ))}
    </div>
  );
}
