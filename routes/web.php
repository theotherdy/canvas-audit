<?php

use Illuminate\Support\Facades\Route;
use App\Http\Controllers\AuditController;

Route::get('/',           [AuditController::class, 'index'])->name('audit.home');
Route::post('/audit/run', [AuditController::class, 'run' ])->name('audit.run');
