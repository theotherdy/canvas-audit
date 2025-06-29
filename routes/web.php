<?php

use Illuminate\Support\Facades\Route;
use App\Http\Controllers\AuditController;
use App\Http\Controllers\DebugController;

Route::get('/',           [AuditController::class, 'index'])->name('audit.home');
Route::post('/audit/run', [AuditController::class, 'run' ])->name('audit.run');

// Debug routes
Route::get('/debug', [DebugController::class, 'index'])->name('debug.index');
Route::get('/debug/test-connection', [DebugController::class, 'testConnection'])->name('debug.test-connection');
Route::post('/debug/test-course', [DebugController::class, 'testCourse'])->name('debug.test-course');
Route::get('/debug/logs', [DebugController::class, 'logs'])->name('debug.logs');
