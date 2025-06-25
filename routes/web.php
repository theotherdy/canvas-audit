<?php

use Illuminate\Support\Facades\Route;

Route::get('/', [\App\Http\Controllers\CourseController::class,'index'])->name('home');
Route::get('/courses/{id}', [\App\Http\Controllers\CourseController::class,'show'])->name('show');

Route::get('/', function () {
    return view('welcome');
});
