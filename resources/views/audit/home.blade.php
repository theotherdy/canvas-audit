{{-- resources/views/audit/home.blade.php --}}
@extends('layouts.app')

@section('content')
<div class="container mt-4">
    <h1 class="h3 mb-4">Canvas Course Audit</h1>

    {{-- validation errors --}}
    @if ($errors->any())
        <div class="alert alert-danger">
            @foreach ($errors->all() as $error)
                <div>{{ $error }}</div>
            @endforeach
        </div>
    @endif

    <form action="{{ route('audit.store') }}" method="POST">
        @csrf

        <div class="mb-3">
            <label for="course_ids" class="form-label">
                Course IDs <small class="text-muted">(comma or space-separated)</small>
            </label>
            <textarea
                name="course_ids"
                id="course_ids"
                rows="4"
                class="form-control"
                placeholder="12345 67890 112233"
            >{{ old('course_ids') }}</textarea>
        </div>

        <button type="submit" class="btn btn-primary">
            Start audit
        </button>
    </form>
</div>
@endsection
