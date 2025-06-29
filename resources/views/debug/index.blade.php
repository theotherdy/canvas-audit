@extends('layouts.app')

@section('content')
<div class="container mt-4">
    <h1 class="h4 mb-4">Canvas Audit Debug Tools</h1>

    <!-- Configuration Status -->
    <div class="card mb-4">
        <div class="card-header">
            <h5 class="mb-0">Configuration Status</h5>
        </div>
        <div class="card-body">
            <div class="row">
                <div class="col-md-6">
                    <p><strong>Canvas Base URL:</strong> 
                        <span class="badge {{ $config['canvas_base_url'] ? 'bg-success' : 'bg-danger' }}">
                            {{ $config['canvas_base_url'] ?: 'NOT SET' }}
                        </span>
                    </p>
                    <p><strong>Canvas Token:</strong> 
                        <span class="badge {{ $config['canvas_token_set'] ? 'bg-success' : 'bg-danger' }}">
                            {{ $config['canvas_token_set'] ? 'SET' : 'NOT SET' }}
                        </span>
                    </p>
                </div>
                <div class="col-md-6">
                    <p><strong>Log Level:</strong> {{ $config['log_level'] }}</p>
                    <p><strong>App Debug:</strong> 
                        <span class="badge {{ $config['app_debug'] ? 'bg-warning' : 'bg-info' }}">
                            {{ $config['app_debug'] ? 'ON' : 'OFF' }}
                        </span>
                    </p>
                </div>
            </div>
        </div>
    </div>

    <!-- API Connection Test -->
    <div class="card mb-4">
        <div class="card-header">
            <h5 class="mb-0">API Connection Test</h5>
        </div>
        <div class="card-body">
            <button id="testConnection" class="btn btn-primary">Test Canvas API Connection</button>
            <div id="connectionResult" class="mt-3"></div>
        </div>
    </div>

    <!-- Course Test -->
    <div class="card mb-4">
        <div class="card-header">
            <h5 class="mb-0">Test Course Endpoints</h5>
        </div>
        <div class="card-body">
            <div class="row">
                <div class="col-md-6">
                    <div class="mb-3">
                        <label for="courseId" class="form-label">Course ID</label>
                        <input type="number" class="form-control" id="courseId" placeholder="Enter course ID">
                    </div>
                    <button id="testCourse" class="btn btn-secondary">Test Course Endpoints</button>
                </div>
            </div>
            <div id="courseResult" class="mt-3"></div>
        </div>
    </div>

    <!-- Logs Viewer -->
    <div class="card mb-4">
        <div class="card-header">
            <h5 class="mb-0">Recent Logs</h5>
        </div>
        <div class="card-body">
            <button id="loadLogs" class="btn btn-info">Load Recent Logs</button>
            <div id="logsResult" class="mt-3">
                <div id="laravelLogs" class="mb-3" style="display: none;">
                    <h6>Laravel Logs</h6>
                    <pre id="laravelContent" style="max-height: 300px; overflow-y: auto; background: #f8f9fa; padding: 1rem; border-radius: 0.375rem; font-size: 0.875rem;"></pre>
                </div>
                <div id="canvasLogs" class="mb-3" style="display: none;">
                    <h6>Canvas API Logs</h6>
                    <pre id="canvasContent" style="max-height: 300px; overflow-y: auto; background: #f8f9fa; padding: 1rem; border-radius: 0.375rem; font-size: 0.875rem;"></pre>
                </div>
            </div>
        </div>
    </div>

    <a href="{{ route('audit.home') }}" class="btn btn-secondary">Back to Audit</a>
</div>

<script>
document.getElementById('testConnection').addEventListener('click', async function() {
    const resultDiv = document.getElementById('connectionResult');
    resultDiv.innerHTML = '<div class="alert alert-info">Testing connection...</div>';
    
    try {
        const response = await fetch('/debug/test-connection');
        const data = await response.json();
        
        if (data.success) {
            resultDiv.innerHTML = `
                <div class="alert alert-success">
                    <strong>Connection successful!</strong><br>
                    Status: ${data.status}<br>
                    URL: ${data.url}
                </div>
            `;
        } else {
            resultDiv.innerHTML = `
                <div class="alert alert-danger">
                    <strong>Connection failed!</strong><br>
                    Error: ${data.error}
                </div>
            `;
        }
    } catch (error) {
        resultDiv.innerHTML = `
            <div class="alert alert-danger">
                <strong>Request failed!</strong><br>
                Error: ${error.message}
            </div>
        `;
    }
});

document.getElementById('testCourse').addEventListener('click', async function() {
    const courseId = document.getElementById('courseId').value;
    const resultDiv = document.getElementById('courseResult');
    
    if (!courseId) {
        resultDiv.innerHTML = '<div class="alert alert-warning">Please enter a course ID</div>';
        return;
    }
    
    resultDiv.innerHTML = '<div class="alert alert-info">Testing course endpoints...</div>';
    
    try {
        const response = await fetch('/debug/test-course', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-CSRF-TOKEN': document.querySelector('meta[name="csrf-token"]').getAttribute('content')
            },
            body: JSON.stringify({ course_id: courseId })
        });
        const data = await response.json();
        
        if (data.error) {
            resultDiv.innerHTML = `<div class="alert alert-danger">Error: ${data.error}</div>`;
            return;
        }
        
        let html = `<div class="alert alert-info">Course ID: ${data.course_id}</div>`;
        html += '<div class="table-responsive"><table class="table table-sm">';
        html += '<thead><tr><th>Endpoint</th><th>Status</th><th>Count</th><th>Details</th></tr></thead><tbody>';
        
        Object.entries(data.results).forEach(([name, result]) => {
            const statusClass = result.success ? 'text-success' : 'text-danger';
            const statusText = result.success ? 'Success' : 'Failed';
            
            html += `
                <tr>
                    <td><code>${name}</code></td>
                    <td class="${statusClass}">${statusText}</td>
                    <td>${result.count || 'N/A'}</td>
                    <td>
                        <small>${result.url || ''}</small>
                        ${result.error ? `<br><small class="text-danger">${result.error}</small>` : ''}
                    </td>
                </tr>
            `;
        });
        
        html += '</tbody></table></div>';
        resultDiv.innerHTML = html;
        
    } catch (error) {
        resultDiv.innerHTML = `
            <div class="alert alert-danger">
                <strong>Request failed!</strong><br>
                Error: ${error.message}
            </div>
        `;
    }
});

document.getElementById('loadLogs').addEventListener('click', async function() {
    const laravelLogs = document.getElementById('laravelLogs');
    const canvasLogs = document.getElementById('canvasLogs');
    const laravelContent = document.getElementById('laravelContent');
    const canvasContent = document.getElementById('canvasContent');
    
    laravelContent.textContent = 'Loading logs...';
    canvasContent.textContent = 'Loading logs...';
    laravelLogs.style.display = 'block';
    canvasLogs.style.display = 'block';
    
    try {
        const response = await fetch('/debug/logs');
        const data = await response.json();
        
        // Handle Laravel logs
        if (data.laravel && data.laravel.exists) {
            laravelContent.textContent = data.laravel.recent_lines.join('\n');
        } else {
            laravelContent.textContent = 'Laravel log file not found';
        }
        
        // Handle Canvas logs
        if (data.canvas && data.canvas.exists) {
            canvasContent.textContent = data.canvas.recent_lines.join('\n');
        } else {
            canvasContent.textContent = 'Canvas log file not found';
        }
        
    } catch (error) {
        laravelContent.textContent = `Error loading logs: ${error.message}`;
        canvasContent.textContent = `Error loading logs: ${error.message}`;
    }
});
</script>
@endsection 