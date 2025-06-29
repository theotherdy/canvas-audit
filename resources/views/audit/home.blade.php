@extends('layouts.app')

@section('content')
<div class="container mt-4">
    <h1 class="h4 mb-4">Canvas Course Audit (synchronous)</h1>

    @if ($errors->any())
        <div class="alert alert-danger">
            {{ $errors->first() }}
        </div>
    @endif

    <form action="{{ route('audit.run') }}" method="POST">
        @csrf
        <div class="mb-3">
            <label for="course_ids" class="form-label">
                Course IDs (comma or space separated)
            </label>
            <textarea id="course_ids" name="course_ids" rows="4"
                      class="form-control">{{ old('course_ids') }}</textarea>
        </div>
        <button class="btn btn-primary">Start audit</button>
    </form>
</div>
@endsection
