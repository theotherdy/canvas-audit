<?php

use Illuminate\Support\Facades\Route;
use App\Http\Controllers\AuditController;
use App\Http\Controllers\AuditProgressController;

/*
|--------------------------------------------------------------------------
| Web Routes
|--------------------------------------------------------------------------
|
| All routes are wrapped in the default "web" middleware group (session,
| CSRF, etc.).  Add 'auth' or a custom gate if you need stricter access.
|
*/

Route::middleware(['web'])->group(function () {

    /*
    |------------------------------------------------------------------
    | 1. Home screen – enter course IDs
    |------------------------------------------------------------------
    | GET /
    */
    Route::get('/', [AuditController::class, 'index'])
        ->name('audit.home');   // shows a Blade form (textarea / input)


    /*
    |------------------------------------------------------------------
    | 2. POST – launch an audit batch
    |------------------------------------------------------------------
    | POST /audit
    | Validates the input, creates an AuditBatch, dispatches the jobs,
    | then redirects to /audit/{batch} (see controller).
    */
    Route::post('/audit', [AuditController::class, 'store'])
        ->name('audit.store');


    /*
    |------------------------------------------------------------------
    | 3. Show progress + final table
    |------------------------------------------------------------------
    | GET /audit/{batch}
    | A Blade view that embeds a Livewire component to display progress
    | until the batch completes, then renders the DataTable results.
    */
    Route::get('/audit/{batch}', [AuditController::class, 'show'])
        ->name('audit.show');


    /*
    |------------------------------------------------------------------
    | 4. JSON progress endpoint  (optional if you rely solely on Livewire)
    |------------------------------------------------------------------
    | GET /audit/{batch}/progress
    | Returns: { processed: int, total: int, percent: int }
    | Useful for vanilla JS polling or SSE; Livewire users can delete if
    | they don’t need it.
    */
    Route::get('/audit/{batch}/progress', AuditProgressController::class)
        ->name('audit.progress');
});
