import type {
  FullConfig, FullResult, Reporter, Suite, TestCase, TestResult
} from '@playwright/test/reporter';
import * as fs from 'fs';
import * as path from 'path';

interface ProjectResults {
  projectName: string;
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  duration: number;
  tests: TestInfo[];
}

interface TestInfo {
  title: string;
  status: string;
  duration: number;
  error?: string;
  file: string;
}

class UnifiedHtmlReporter implements Reporter {
  private projectResults: Map<string, ProjectResults> = new Map();
  private startTime: number = 0;

  onBegin(config: FullConfig, suite: Suite) {
    this.startTime = Date.now();
    console.log(`Starting test execution with ${suite.allTests().length} tests`);
  }

  onTestEnd(test: TestCase, result: TestResult) {
    const projectName = this.getProjectName(test.location.file);
    
    if (!this.projectResults.has(projectName)) {
      this.projectResults.set(projectName, {
        projectName,
        total: 0,
        passed: 0,
        failed: 0,
        skipped: 0,
        duration: 0,
        tests: []
      });
    }

    const project = this.projectResults.get(projectName)!;
    project.total++;
    project.duration += result.duration;

    if (result.status === 'passed') project.passed++;
    else if (result.status === 'failed') project.failed++;
    else if (result.status === 'skipped') project.skipped++;

    project.tests.push({
      title: test.title,
      status: result.status,
      duration: result.duration,
      error: result.error?.message,
      file: test.location.file
    });
  }

  async onEnd(result: FullResult) {
    const duration = Date.now() - this.startTime;
    await this.generateHtmlReport(duration);
  }

  private getProjectName(filePath: string): string {
    if (filePath.includes('app-status')) return 'App Status Verification';
    if (filePath.includes('server-health')) return 'Server Health Monitoring';
    if (filePath.includes('certificate')) return 'Certificate Expiry Tests';
    if (filePath.includes('api')) return 'API Tests';
    return 'Other Tests';
  }

  private async generateHtmlReport(totalDuration: number) {
    const reportPath = path.join(process.cwd(), 'unified-report', 'index.html');
    const reportDir = path.dirname(reportPath);

    if (!fs.existsSync(reportDir)) {
      fs.mkdirSync(reportDir, { recursive: true });
    }

    const html = this.generateHtmlContent(totalDuration);
    fs.writeFileSync(reportPath, html);
    
    console.log(`\n📊 Unified HTML Report generated: ${reportPath}`);
  }

  private generateHtmlContent(totalDuration: number): string {
    const timestamp = new Date().toLocaleString();
    let totalTests = 0;
    let totalPassed = 0;
    let totalFailed = 0;
    let totalSkipped = 0;

    this.projectResults.forEach(project => {
      totalTests += project.total;
      totalPassed += project.passed;
      totalFailed += project.failed;
      totalSkipped += project.skipped;
    });

    const passRate = totalTests > 0 ? ((totalPassed / totalTests) * 100).toFixed(2) : '0';

    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>AdHash Unified Test Report</title>
    <style>
        ${this.getStyles()}
    </style>
</head>
<body>
    <div class="container">
        <header>
            <h1>🎯 AdHash Unified Test Report</h1>
            <p class="timestamp">Generated: ${timestamp}</p>
        </header>

        <div class="summary-cards">
            <div class="card total">
                <div class="card-value">${totalTests}</div>
                <div class="card-label">Total Tests</div>
            </div>
            <div class="card passed">
                <div class="card-value">${totalPassed}</div>
                <div class="card-label">Passed</div>
            </div>
            <div class="card failed">
                <div class="card-value">${totalFailed}</div>
                <div class="card-label">Failed</div>
            </div>
            <div class="card skipped">
                <div class="card-value">${totalSkipped}</div>
                <div class="card-label">Skipped</div>
            </div>
            <div class="card duration">
                <div class="card-value">${(totalDuration / 1000).toFixed(2)}s</div>
                <div class="card-label">Duration</div>
            </div>
            <div class="card pass-rate">
                <div class="card-value">${passRate}%</div>
                <div class="card-label">Pass Rate</div>
            </div>
        </div>

        ${this.generateProjectSections()}

    </div>
    <script>
        ${this.getJavaScript()}
    </script>
</body>
</html>`;
  }

  private generateProjectSections(): string {
    let html = '<div class="projects-container">';

    this.projectResults.forEach(project => {
      const passRate = project.total > 0 ? ((project.passed / project.total) * 100).toFixed(2) : '0';
      const statusClass = project.failed > 0 ? 'failed' : 'passed';

      html += `
        <div class="project-section">
            <div class="project-header ${statusClass}">
                <h2>${project.projectName}</h2>
                <div class="project-stats">
                    <span class="stat">Total: ${project.total}</span>
                    <span class="stat passed">✓ ${project.passed}</span>
                    <span class="stat failed">✗ ${project.failed}</span>
                    <span class="stat skipped">⊘ ${project.skipped}</span>
                    <span class="stat">Pass Rate: ${passRate}%</span>
                    <span class="stat">Duration: ${(project.duration / 1000).toFixed(2)}s</span>
                </div>
            </div>
            <div class="tests-table">
                <table>
                    <thead>
                        <tr>
                            <th>Test Name</th>
                            <th>Status</th>
                            <th>Duration</th>
                            <th>Details</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${project.tests.map(test => `
                            <tr class="test-row ${test.status}">
                                <td class="test-name">${test.title}</td>
                                <td class="test-status">
                                    <span class="status-badge ${test.status}">${test.status.toUpperCase()}</span>
                                </td>
                                <td class="test-duration">${(test.duration / 1000).toFixed(2)}s</td>
                                <td class="test-details">
                                    ${test.error ? `<details><summary>Error</summary><pre>${this.escapeHtml(test.error)}</pre></details>` : '-'}
                                </td>
                            </tr>
                        `).join('')}
                    </tbody>
                </table>
            </div>
        </div>
      `;
    });

    html += '</div>';
    return html;
  }

  private escapeHtml(text: string): string {
    const map: { [key: string]: string } = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#039;'
    };
    return text.replace(/[&<>"']/g, m => map[m]);
  }

  private getStyles(): string {
    return `
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }

        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            min-height: 100vh;
            padding: 20px;
        }

        .container {
            max-width: 1400px;
            margin: 0 auto;
            background: white;
            border-radius: 16px;
            box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3);
            overflow: hidden;
        }

        header {
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            padding: 40px;
            text-align: center;
        }

        header h1 {
            font-size: 2.5em;
            margin-bottom: 10px;
            font-weight: 700;
        }

        .timestamp {
            font-size: 1.1em;
            opacity: 0.9;
        }

        .summary-cards {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
            gap: 20px;
            padding: 30px;
            background: #f8f9fa;
        }

        .card {
            background: white;
            padding: 25px;
            border-radius: 12px;
            text-align: center;
            box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
            transition: transform 0.2s, box-shadow 0.2s;
        }

        .card:hover {
            transform: translateY(-5px);
            box-shadow: 0 8px 12px rgba(0, 0, 0, 0.15);
        }

        .card-value {
            font-size: 2.5em;
            font-weight: bold;
            margin-bottom: 8px;
        }

        .card-label {
            font-size: 0.9em;
            color: #666;
            text-transform: uppercase;
            letter-spacing: 1px;
        }

        .card.total .card-value { color: #667eea; }
        .card.passed .card-value { color: #10b981; }
        .card.failed .card-value { color: #ef4444; }
        .card.skipped .card-value { color: #f59e0b; }
        .card.duration .card-value { color: #3b82f6; }
        .card.pass-rate .card-value { color: #8b5cf6; }

        .projects-container {
            padding: 30px;
        }

        .project-section {
            margin-bottom: 40px;
            border-radius: 12px;
            overflow: hidden;
            box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
        }

        .project-header {
            padding: 25px;
            color: white;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
        }

        .project-header.failed {
            background: linear-gradient(135deg, #ef4444 0%, #dc2626 100%);
        }

        .project-header h2 {
            font-size: 1.8em;
            margin-bottom: 15px;
        }

        .project-stats {
            display: flex;
            flex-wrap: wrap;
            gap: 20px;
            font-size: 1em;
        }

        .project-stats .stat {
            background: rgba(255, 255, 255, 0.2);
            padding: 8px 16px;
            border-radius: 20px;
            backdrop-filter: blur(10px);
        }

        .tests-table {
            background: white;
        }

        table {
            width: 100%;
            border-collapse: collapse;
        }

        thead {
            background: #f8f9fa;
        }

        th {
            padding: 15px;
            text-align: left;
            font-weight: 600;
            color: #374151;
            border-bottom: 2px solid #e5e7eb;
        }

        td {
            padding: 15px;
            border-bottom: 1px solid #e5e7eb;
        }

        .test-row:hover {
            background: #f9fafb;
        }

        .test-name {
            font-weight: 500;
            color: #1f2937;
        }

        .status-badge {
            padding: 6px 12px;
            border-radius: 6px;
            font-size: 0.85em;
            font-weight: 600;
            text-transform: uppercase;
        }

        .status-badge.passed {
            background: #d1fae5;
            color: #065f46;
        }

        .status-badge.failed {
            background: #fee2e2;
            color: #991b1b;
        }

        .status-badge.skipped {
            background: #fef3c7;
            color: #92400e;
        }

        details {
            cursor: pointer;
        }

        summary {
            color: #ef4444;
            font-weight: 500;
        }

        pre {
            background: #f3f4f6;
            padding: 10px;
            border-radius: 6px;
            overflow-x: auto;
            margin-top: 10px;
            font-size: 0.85em;
            color: #dc2626;
        }

        @media (max-width: 768px) {
            .summary-cards {
                grid-template-columns: repeat(2, 1fr);
            }

            header h1 {
                font-size: 1.8em;
            }

            .project-stats {
                flex-direction: column;
                gap: 10px;
            }
        }
    `;
  }

  private getJavaScript(): string {
    return `
        // Add smooth scrolling
        document.querySelectorAll('a[href^="#"]').forEach(anchor => {
            anchor.addEventListener('click', function (e) {
                e.preventDefault();
                const target = document.querySelector(this.getAttribute('href'));
                if (target) {
                    target.scrollIntoView({ behavior: 'smooth' });
                }
            });
        });

        // Add animation on load
        window.addEventListener('load', () => {
            document.querySelectorAll('.card').forEach((card, index) => {
                setTimeout(() => {
                    card.style.opacity = '0';
                    card.style.transform = 'translateY(20px)';
                    card.style.transition = 'opacity 0.5s, transform 0.5s';
                    setTimeout(() => {
                        card.style.opacity = '1';
                        card.style.transform = 'translateY(0)';
                    }, 50);
                }, index * 100);
            });
        });

        // Print functionality
        function printReport() {
            window.print();
        }
    `;
  }
}

export default UnifiedHtmlReporter;

