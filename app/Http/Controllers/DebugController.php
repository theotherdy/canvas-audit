<?php

namespace App\Http\Controllers;

use Illuminate\Http\Request;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Facades\Log;
use Illuminate\Support\Facades\Config;

class DebugController extends Controller
{
    public function index()
    {
        $config = [
            'canvas_base_url' => config('services.canvas.base_url'),
            'canvas_token_set' => !empty(config('services.canvas.token')),
            'log_level' => config('logging.default'),
            'app_debug' => config('app.debug'),
        ];

        return view('debug.index', compact('config'));
    }

    public function testConnection()
    {
        try {
            $baseUrl = rtrim(config('services.canvas.base_url'), '/');
            $token = config('services.canvas.token');

            if (empty($baseUrl) || empty($token)) {
                return response()->json([
                    'success' => false,
                    'error' => 'Canvas configuration missing'
                ]);
            }

            $response = Http::withToken($token)
                ->timeout(10)
                ->get("{$baseUrl}/courses");

            return response()->json([
                'success' => $response->successful(),
                'status' => $response->status(),
                'headers' => $response->headers(),
                'body_preview' => substr($response->body(), 0, 500) . '...',
                'url' => "{$baseUrl}/courses"
            ]);

        } catch (\Throwable $e) {
            Log::error('Debug connection test failed', [
                'error' => $e->getMessage(),
                'file' => $e->getFile(),
                'line' => $e->getLine()
            ]);

            return response()->json([
                'success' => false,
                'error' => $e->getMessage(),
                'file' => $e->getFile(),
                'line' => $e->getLine()
            ]);
        }
    }

    public function testCourse(Request $request)
    {
        $courseId = $request->input('course_id');
        
        if (!$courseId) {
            return response()->json(['error' => 'Course ID required']);
        }

        try {
            $baseUrl = rtrim(config('services.canvas.base_url'), '/');
            $token = config('services.canvas.token');

            $endpoints = [
                'course_info' => "/courses/{$courseId}",
                'enrollments' => "/courses/{$courseId}/enrollments",
                'pages' => "/courses/{$courseId}/pages",
                'quizzes' => "/courses/{$courseId}/quizzes",
                'assignments' => "/courses/{$courseId}/assignments",
                'discussions' => "/courses/{$courseId}/discussion_topics"
            ];

            $results = [];

            foreach ($endpoints as $name => $endpoint) {
                try {
                    $response = Http::withToken($token)
                        ->timeout(15)
                        ->get("{$baseUrl}{$endpoint}");

                    $results[$name] = [
                        'success' => $response->successful(),
                        'status' => $response->status(),
                        'count' => count($response->json()),
                        'url' => "{$baseUrl}{$endpoint}"
                    ];

                    if (!$response->successful()) {
                        $results[$name]['error'] = $response->body();
                    }

                } catch (\Throwable $e) {
                    $results[$name] = [
                        'success' => false,
                        'error' => $e->getMessage()
                    ];
                }
            }

            return response()->json([
                'course_id' => $courseId,
                'results' => $results
            ]);

        } catch (\Throwable $e) {
            Log::error('Debug course test failed', [
                'course_id' => $courseId,
                'error' => $e->getMessage()
            ]);

            return response()->json([
                'error' => $e->getMessage()
            ]);
        }
    }

    public function logs()
    {
        $logFiles = [
            'laravel' => storage_path('logs/laravel.log'),
            'canvas' => storage_path('logs/canvas.log')
        ];
        
        $results = [];
        
        foreach ($logFiles as $name => $logFile) {
            if (file_exists($logFile)) {
                $lines = file($logFile, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES);
                $results[$name] = [
                    'file' => $logFile,
                    'total_lines' => count($lines),
                    'recent_lines' => array_slice($lines, -50), // Last 50 lines
                    'exists' => true
                ];
            } else {
                $results[$name] = [
                    'file' => $logFile,
                    'exists' => false
                ];
            }
        }

        return response()->json($results);
    }
} 